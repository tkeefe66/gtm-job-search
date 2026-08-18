import { beforeEach, describe, expect, test, vi } from "vitest";

// Same harness lesson as app/actions/roles.test.ts: mock the edges, keep the
// decision. ingestRoles reaches the database, the jobs actions, the fit
// scorer and the URL checker; all four are replaced here. What is left is the
// insert-failed decision, which is the whole of what these tests pin.
const h = vi.hoisted(() => ({
  addJobResult: { job: undefined, error: undefined } as {
    job?: { id: string };
    error?: string;
  },
  // The two independent signals ingestRoles closes a role on. Defaults are the
  // healthy path, so every pre-existing test in this file keeps its meaning.
  urlStatus: "live" as "live" | "dead" | "unknown",
  resolved: null as {
    url: string;
    vendor: string;
    slug: string;
    precision: "posting" | "absent" | "ambiguous";
  } | null,
}));

vi.mock("@/lib/supabase", () => ({
  // No rows: every role under test is new.
  rawQuery: vi.fn(async () => ({ data: [], error: null })),
}));
vi.mock("@/app/actions/jobs", () => ({
  addJob: vi.fn(async () => h.addJobResult),
  updateJob: vi.fn(async () => ({})),
}));
vi.mock("@/app/actions/parse-role", () => ({
  scoreFit: vi.fn(async () => ({ score: 4, rationale: "fits" })),
}));
vi.mock("@/lib/tenant", () => ({
  resolveTenantId: async () => "00000000-0000-0000-0000-000000000001",
}));
vi.mock("@/lib/verify-url", () => ({ checkJobUrl: vi.fn(async () => h.urlStatus) }));
// Not mocked before: ROLE's example.com link classifies as "other", so
// upgradeLink returned early and never reached this module. The unlisted case
// below uses an aggregator link, which does reach it.
vi.mock("@/lib/resolve-job-link", () => ({
  resolveEmployerLink: vi.fn(async () => h.resolved),
}));

import { ingestRoles } from "./ingest-roles";
import { UNDESCRIBED_DB_ERROR } from "@/lib/write-failure";
import { addJob } from "@/app/actions/jobs";
import { scoreFit } from "@/app/actions/parse-role";
import type { Role } from "@/lib/types";

const ROLE: Role = {
  role_title: "RevOps Manager",
  job_url: "https://example.com/jobs/1",
  location: "Remote",
  seniority: "Manager",
  salary_range: "$180,000 - $220,000",
  description_summary: "Own the GTM stack",
  fit_signal: "Strong",
  ic_flag: false,
};

const OPTS = {
  company: "Clay",
  roles: [ROLE],
  source: "Crawl",
  fitInputs: {} as never,
};

beforeEach(() => {
  h.addJobResult = { job: undefined, error: undefined };
  h.urlStatus = "live";
  h.resolved = null;
  vi.clearAllMocks();
});

// The empty-message case is not hypothetical: lib/write-failure.ts records
// that `pg` rejects with an AggregateError — message "" — whenever a
// dual-stack host refuses on every address, which is exactly what an unset or
// unreachable DATABASE_URL produces. `if (jobRes.error)` reads that as
// success. A crawl would then report roles it never stored, and the crawler's
// own dedupe would treat them as already seen on the next pass.
describe("a role whose insert failed is not reported as added", () => {
  test("an insert failure WITH a message is not added", async () => {
    h.addJobResult = { error: "duplicate key violates unique constraint" };

    const res = await ingestRoles(OPTS);

    expect(res.added).toEqual([]);
  });

  test("an insert failure with an EMPTY message is not added either", async () => {
    h.addJobResult = { error: "" };

    const res = await ingestRoles(OPTS);

    expect(res.added).toEqual([]);
  });

  test("a message-less failure is logged with the stand-in, not a dangling dash", async () => {
    h.addJobResult = { error: "" };
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await ingestRoles(OPTS);

    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0][0]).toContain(UNDESCRIBED_DB_ERROR);
    logged.mockRestore();
  });

  test("a successful insert is still added", async () => {
    h.addJobResult = { job: { id: "job-1" } };

    const res = await ingestRoles(OPTS);

    expect(res.added).toEqual([ROLE]);
  });
});

/** The payload of the only addJob call this ingest made. */
const insertedRow = () => vi.mocked(addJob).mock.calls[0][0];

// never_live is NARROWER than the condition that closes a role, and the gap is
// the whole point. A guessed board slug is not proof a posting never existed,
// and a hidden row can never come back: ingestRoles' dedupe reads every row
// regardless of status, so the next run skips it as already seen.
describe("never_live records only the definitive death signal", () => {
  test("a role whose URL 404s is stored closed AND flagged never_live", async () => {
    h.addJobResult = { job: { id: "job-1" } };
    h.urlStatus = "dead";

    await ingestRoles(OPTS);

    expect(insertedRow().status).toBe("Posting Closed");
    expect(insertedRow().never_live).toBe(true);
  });

  test("a role missing from the employer's guessed board is closed but NOT flagged", async () => {
    h.addJobResult = { job: { id: "job-1" } };
    h.urlStatus = "live";
    h.resolved = {
      url: "https://job-boards.greenhouse.io/clay",
      vendor: "greenhouse",
      slug: "clay",
      precision: "absent",
    };

    // An aggregator link, so upgradeLink actually consults the board. ROLE's
    // own example.com link classifies as "other" and would return early.
    await ingestRoles({
      ...OPTS,
      roles: [{ ...ROLE, job_url: "https://www.builtin.com/job/12345" }],
    });

    expect(insertedRow().status).toBe("Posting Closed");
    expect(insertedRow().never_live).toBe(false);
  });

  test("a live role is stored New and not flagged", async () => {
    h.addJobResult = { job: { id: "job-1" } };

    await ingestRoles(OPTS);

    expect(insertedRow().status).toBe("New");
    expect(insertedRow().never_live).toBe(false);
  });

  test("a role found dead is still not fit-scored", async () => {
    h.addJobResult = { job: { id: "job-1" } };
    h.urlStatus = "dead";

    await ingestRoles(OPTS);

    expect(vi.mocked(scoreFit)).not.toHaveBeenCalled();
  });
});
