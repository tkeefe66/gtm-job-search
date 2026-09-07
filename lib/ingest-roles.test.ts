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
    precision: "posting" | "absent" | "ambiguous" | "empty";
  } | null,
  // The ATS deep-link path: vendor and slug are read out of the stored URL, so
  // this is a different lookup from the guessed-slug one above and needs its
  // own stub. Default is the inert outcome, so every pre-existing test in this
  // file keeps its meaning.
  verified: { kind: "notApplicable" } as
    | { kind: "notApplicable" }
    | { kind: "listed" }
    | { kind: "unreachable" }
    | { kind: "relink"; url: string }
    | { kind: "unclear"; reason: "ambiguous" | "empty"; url: string }
    | { kind: "absent"; url: string },
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
  verifyPostingLink: vi.fn(async () => h.verified),
  newBoardCache: () => new Map(),
}));

import { ingestRoles } from "./ingest-roles";
import { UNDESCRIBED_DB_ERROR } from "@/lib/write-failure";
import { addJob } from "@/app/actions/jobs";
import { scoreFit } from "@/app/actions/parse-role";
import { resolveEmployerLink, verifyPostingLink } from "@/lib/resolve-job-link";
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
  h.verified = { kind: "notApplicable" };
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

  // `empty` is a NEW precision value, added so the link-health report can tell
  // "this board lists nothing" apart from "several postings could be this
  // role". Only `absent` may close a role, and this pins that the new value did
  // not quietly join it — a fourth branch that closed here would mark a role
  // Posting Closed because a GUESSED slug found an empty board, and hide it if
  // it also 404'd.
  test("a role whose employer board is empty is untouched — New, not flagged", async () => {
    h.addJobResult = { job: { id: "job-1" } };
    h.urlStatus = "live";
    h.resolved = {
      url: "https://job-boards.greenhouse.io/clay",
      vendor: "greenhouse",
      slug: "clay",
      precision: "empty",
    };

    await ingestRoles({
      ...OPTS,
      roles: [{ ...ROLE, job_url: "https://www.builtin.com/job/12345" }],
    });

    expect(insertedRow().status).toBe("New");
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

  test("a role whose URL check was inconclusive is New and not flagged", async () => {
    h.addJobResult = { job: { id: "job-1" } };
    h.urlStatus = "unknown"; // 403 / timeout — the common case

    await ingestRoles(OPTS);

    expect(insertedRow().status).toBe("New");
    expect(insertedRow().never_live).toBe(false);
  });
});

// The defect this path exists for: a stored Ashby link
// (jobs.ashbyhq.com/baseten/<id>) whose posting id is dead. Ashby's posting
// page is a client-rendered SPA that answers HTTP 200 and then paints "Job not
// found", so checkJobUrl says "live"; and the URL classifies as `ats`, so the
// old `!== "aggregator"` early return meant the employer's own honest board API
// was never asked about the id. Both gates missed it.
describe("an ATS deep link is verified against its own vendor's board", () => {
  const STALE = "https://jobs.ashbyhq.com/baseten/b621b620-85eb-4f73-8d77-e4ebd458b02d";
  const LIVE = "https://jobs.ashbyhq.com/baseten/5cd2f489-b9ee-428b-b252-94e83d55f107";
  const ashbyRole = { ...ROLE, role_title: "GTM Engineer", job_url: STALE };

  // Mutation this catches: restoring the `classifyJobLink(url) !== "aggregator"`
  // early return in upgradeLink. The row is then stored pointing at the dead id.
  test("a relink stores the board's URL and keeps the original as source_url", async () => {
    h.addJobResult = { job: { id: "job-1" } };
    h.verified = { kind: "relink", url: LIVE };

    await ingestRoles({ ...OPTS, company: "Baseten", roles: [ashbyRole] });

    expect(insertedRow().job_url).toBe(LIVE);
    expect(insertedRow().source_url).toBe(STALE);
  });

  // Mutation this catches: setting `unlisted: true` on this path — the obvious
  // "the board doesn't have it, so it's gone" reading. It is strong evidence,
  // but `unlisted` CLOSES the role and a closed role can never come back:
  // ingestRoles' dedupe reads every row regardless of status. This change points
  // links at the right place; it does not widen what closes roles.
  test("a relinked role stays New and is never flagged never_live", async () => {
    h.addJobResult = { job: { id: "job-1" } };
    h.verified = { kind: "relink", url: LIVE };

    await ingestRoles({ ...OPTS, company: "Baseten", roles: [ashbyRole] });

    expect(insertedRow().status).toBe("New");
    expect(insertedRow().never_live).toBe(false);
  });

  // Mutation this catches: acting on any non-`listed` outcome — e.g. relinking
  // to `url` whatever the kind is. A board we could not read says NOTHING about
  // the posting, and an empty board never concludes anything anywhere in this
  // codebase. Both must leave the row exactly as it arrived.
  test("unreachable, empty, ambiguous, absent and listed all change nothing", async () => {
    const inert = [
      { kind: "unreachable" },
      { kind: "listed" },
      { kind: "unclear", reason: "empty", url: "https://jobs.ashbyhq.com/baseten" },
      { kind: "unclear", reason: "ambiguous", url: "https://jobs.ashbyhq.com/baseten" },
      { kind: "absent", url: "https://jobs.ashbyhq.com/baseten" },
    ] as const;

    for (const verified of inert) {
      vi.clearAllMocks();
      h.addJobResult = { job: { id: "job-1" } };
      h.verified = verified as typeof h.verified;

      await ingestRoles({ ...OPTS, company: "Baseten", roles: [ashbyRole] });

      expect(insertedRow().job_url).toBe(STALE);
      expect(insertedRow().source_url ?? null).toBeNull();
      expect(insertedRow().status).toBe("New");
      expect(insertedRow().never_live).toBe(false);
    }
  });

  // Mutation this catches: routing ATS links through resolveEmployerLink (the
  // guessed-slug path) as well as, or instead of, the read-slug one. That path
  // can CLOSE a role on `absent`, which is exactly the blast radius this change
  // is keeping small.
  test("the guessed-slug resolver is never consulted for an ATS link", async () => {
    h.addJobResult = { job: { id: "job-1" } };
    h.verified = { kind: "relink", url: LIVE };

    await ingestRoles({ ...OPTS, company: "Baseten", roles: [ashbyRole] });

    expect(vi.mocked(resolveEmployerLink)).not.toHaveBeenCalled();
    expect(vi.mocked(verifyPostingLink)).toHaveBeenCalledWith(STALE, "GTM Engineer", expect.any(Map));
  });

  // Mutation this catches: dropping the aggregator branch while restructuring,
  // or letting the new ATS branch swallow it.
  test("an aggregator link still goes to the guessed-slug resolver, not the new path", async () => {
    h.addJobResult = { job: { id: "job-1" } };

    await ingestRoles({
      ...OPTS,
      roles: [{ ...ROLE, job_url: "https://www.builtin.com/job/12345" }],
    });

    expect(vi.mocked(resolveEmployerLink)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(verifyPostingLink)).not.toHaveBeenCalled();
  });
});
