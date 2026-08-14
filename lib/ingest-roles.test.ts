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
vi.mock("@/lib/verify-url", () => ({ checkJobUrl: vi.fn(async () => "alive") }));

import { ingestRoles } from "./ingest-roles";
import { UNDESCRIBED_DB_ERROR } from "@/lib/write-failure";
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
