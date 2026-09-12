import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

// Opt-in only; never fall back to DATABASE_URL (which may be production).
const url = process.env.TEST_POSTGRES_URL;
const schema = `ingest_test_${randomUUID().replace(/-/g, "")}`;
const tenant = "00000000-0000-0000-0000-000000000001";
const h = vi.hoisted(() => ({ read: async () => ({ kind: "unreadable" }) }));
vi.mock("@/lib/require-actor", () => ({ requireActor: async () => ({ tenantId: "00000000-0000-0000-0000-000000000001" }) }));
vi.mock("@/lib/tenant", () => ({ resolveTenantId: async () => "00000000-0000-0000-0000-000000000001" }));
vi.mock("@/app/actions/parse-role", () => ({ scoreFit: vi.fn(async () => ({ score: 4, rationale: "fits" })) }));
vi.mock("@/lib/grading-store", () => ({ gradingPaused: async () => null, updateMissingGrade: async () => ({ saved: true }), recordGradeFailure: vi.fn() }));
vi.mock("@/lib/verify-url", () => ({ checkJobUrl: async () => "live" }));
vi.mock("@/lib/resolve-job-link", () => ({ newBoardCache: () => new Map(), verifyPostingLink: async () => ({ kind: "notApplicable" }) }));
vi.mock("@/lib/posting-read", () => ({ readPosting: () => h.read(), readDetail: () => null }));

import { acceptJob } from "./job-acceptance";
import { ingestRoles } from "./ingest-roles";
import { addJob } from "@/app/actions/jobs";
import { scoreFit } from "@/app/actions/parse-role";
import type { Role } from "./types";

describe.skipIf(!url)("atomic job acceptance on isolated PostgreSQL schema", () => {
  let admin: Pool;
  let pool: Pool;
  let previousPool: Pool | undefined;
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) throw new Error("TEST_POSTGRES_URL must point at local isolated PostgreSQL");
    admin = new Pool({ connectionString: url });
    await admin.query(`create schema ${schema}`);
    pool = new Pool({ connectionString: url, max: 8, options: `-c search_path=${schema}` });
    const globalPool = globalThis as unknown as { __pgPool?: Pool };
    previousPool = globalPool.__pgPool;
    globalPool.__pgPool = pool;
    const baseline = readFileSync("db/schema.sql", "utf8").match(/create table if not exists jobs \([\s\S]*?\n\);/)![0];
    await pool.query(baseline);
    await pool.query(`alter table jobs add tenant_id uuid not null, add source_url text,
      add posting jsonb, add never_live boolean default false, add grading_chosen boolean,
      add grading_state text, add grading_attempts int, add grading_lease uuid, add grading_next_at timestamptz;
      create table app_settings (tenant_id uuid, key text, value jsonb);`);
  });
  beforeEach(async () => {
    await pool.query("truncate jobs");
    vi.clearAllMocks();
    h.read = async () => ({ kind: "unreadable" });
  });
  afterAll(async () => {
    (globalThis as unknown as { __pgPool?: Pool }).__pgPool = previousPool;
    if (pool) await pool.end();
    if (admin) {
      await admin.query(`drop schema if exists ${schema} cascade`);
      await admin.end();
    }
  });

  const role: Role = { role_title: "Director", job_url: "https://example.com/jobs/one", location: "Remote", seniority: "Director", salary_range: "", description_summary: "", fit_signal: "", ic_flag: false };

  test("overlapping manual and crawl ingestion persist one job and buy exactly one grade", async () => {
    let reads = 0;
    let release!: () => void;
    const bothReading = new Promise<void>(resolve => { release = resolve; });
    h.read = async () => { if (++reads === 2) release(); await bothReading; return { kind: "unreadable" }; };
    const options = { company: "Example", roles: [role], fitInputs: {} as never };
    const results = await Promise.all([
      ingestRoles({ ...options, source: "Manual", chosenByUser: true }),
      ingestRoles({ ...options, source: "Crawl" }),
    ]);
    expect(results.reduce((n, result) => n + result.added.length, 0)).toBe(1);
    expect(results.reduce((n, result) => n + result.skipped.length, 0)).toBe(1);
    expect((await pool.query("select * from jobs")).rows).toHaveLength(1);
    expect(scoreFit).toHaveBeenCalledTimes(1);
  });

  test("parallel direct actions use normalized title identity and preserve the winning user edits", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => addJob({
      company: i % 2 ? " BIG\u00a0 Co " : "Big Co", role_title: i % 2 ? " DIRECTOR " : "Director",
      job_url: `https://example.com/jobs/${i}`, status: "Rejected", notes: `user notes ${i}`,
    })));
    expect(results.filter(result => result.inserted)).toHaveLength(1);
    expect(new Set(results.map(result => result.job?.id)).size).toBe(1);
    const winner = results.find(result => result.inserted)!.job!;
    const duplicate = await addJob({ company: "big co", role_title: "director", status: "New", notes: "overwrite" });
    expect(duplicate).toMatchObject({ inserted: false, job: { id: winner.id, status: "Rejected", notes: winner.notes } });
  });

  test("URL aliases connect relinks across company spellings, but never across tenants", async () => {
    const first = await acceptJob(tenant, { company: "Example", role_title: "Director", job_url: role.job_url, source_url: "https://example.com/old/one" });
    const alias = await acceptJob(tenant, { company: "Example Incorporated", role_title: "Different title", job_url: "https://example.com/old/one" });
    expect(alias).toMatchObject({ inserted: false, job: { id: first.job.id } });
    expect((await acceptJob("00000000-0000-0000-0000-000000000002", { company: "Example", role_title: "Director", job_url: role.job_url })).inserted).toBe(true);
    expect((await acceptJob(tenant, { company: "Another", role_title: "Different", job_url: role.job_url + "?id=2" })).inserted).toBe(true);
  });

  test("legacy duplicates and terminal statuses remain intact when rediscovered", async () => {
    await pool.query(`insert into jobs(tenant_id,company,role_title,status,notes) values
      ($1,'Example','Director','Rejected','first note'), ($1,'Example','Director','Applied','second note')`, [tenant]);
    const before = (await pool.query("select * from jobs order by id")).rows;
    expect((await addJob({ company: "Example", role_title: "Director", status: "New" })).inserted).toBe(false);
    expect((await pool.query("select * from jobs order by id")).rows).toEqual(before);
  });
});
