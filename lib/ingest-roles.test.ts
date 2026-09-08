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
  score: 4,
  statuses: [
    { key: "New", label: "New", bucket: "active", hidden: false },
    { key: "Not Interested", label: "Not Interested", bucket: "terminal", hidden: false },
  ] as { key: string; label: string; bucket: string; hidden: boolean }[],
  read: { kind: "unreadable" } as
    | { kind: "unreadable" }
    | { kind: "failed"; message: string }
    | {
        kind: "read";
        detail: { requirements: string[]; niceToHaves: string[] };
        department: string;
        employer: string;
        summary: string;
        empty: boolean;
      },
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
vi.mock("@/app/actions/parse-role", () => ({
  scoreFit: vi.fn(async () => ({ score: h.score, rationale: "fits" })),
}));
vi.mock("@/app/actions/jobs", async () => ({
  addJob: vi.fn(async () => h.addJobResult),
  updateJob: vi.fn(async () => ({})),
  getJobStatuses: vi.fn(async () => ({ statuses: h.statuses })),
}));
vi.mock("@/lib/tenant", () => ({
  resolveTenantId: async () => "00000000-0000-0000-0000-000000000001",
}));
vi.mock("@/lib/verify-url", () => ({ checkJobUrl: vi.fn(async () => h.urlStatus) }));
vi.mock("@/lib/posting-read", () => ({
  readPosting: vi.fn(async () => h.read),
  readDetail: (read: { detail: unknown }) => ({
    ...(read.detail as object),
    enrichedAt: "2026-09-08T00:00:00.000Z",
  }),
}));
// Not mocked before: ROLE's example.com link classifies as "other", so
// upgradeLink returned early and never reached this module. The unlisted case
// below uses an aggregator link, which does reach it.
vi.mock("@/lib/resolve-job-link", () => ({
  resolveEmployerLink: vi.fn(async () => h.resolved),
  verifyPostingLink: vi.fn(async () => h.verified),
  newBoardCache: () => new Map(),
}));

import { MAX_INGEST_READS, ingestRoles } from "./ingest-roles";
import { readPosting } from "@/lib/posting-read";
import { UNDESCRIBED_DB_ERROR } from "@/lib/write-failure";
import { addJob, updateJob } from "@/app/actions/jobs";
import { scoreFit } from "@/app/actions/parse-role";
import { resolveEmployerLink, verifyPostingLink } from "@/lib/resolve-job-link";
import { INGEST_EXEMPT_COLUMNS, SCORING_INPUT_COLUMNS } from "@/lib/rescore-scope";
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
  h.read = { kind: "unreadable" };
  h.score = 4;
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

// Defects 1 and 3 of docs/superpowers/specs/2026-09-07-posting-detail-design.md:
// ingest produced the posting's substance, passed it to scoreFit, and threw it
// away. The row then had "" where the model had seen real text, so every
// rescore was strictly impoverished — and the rescore's score is the one that
// persists.
describe("ingest persists the posting detail it already scored on", () => {
  test("the extraction's description summary is stored as key_skills", async () => {
    h.addJobResult = { job: { id: "job-1" } };

    await ingestRoles(OPTS);

    expect(insertedRow().key_skills).toBe(ROLE.description_summary);
  });

  test("the company context is stored as company_description", async () => {
    h.addJobResult = { job: { id: "job-1" } };

    await ingestRoles({
      ...OPTS,
      companyContext: { tagline: "Data enrichment", traction: "Series B" },
    });

    expect(insertedRow().company_description).toBe("Data enrichment. Series B");
  });

  // The stored row and the scored inputs must agree, or the first score and
  // every rescore are computed from different text.
  test("the stored columns are the ones scoreFit was given", async () => {
    h.addJobResult = { job: { id: "job-1" } };

    await ingestRoles({
      ...OPTS,
      companyContext: { tagline: "Data enrichment", traction: "Series B" },
    });

    const scored = vi.mocked(scoreFit).mock.calls[0][0];
    expect(insertedRow().key_skills).toBe(scored.key_skills);
    expect(insertedRow().company_description).toBe(scored.company_description);
  });
});

// The fourth defect, cosmetic but on every path: `${tagline}. ${traction}`
// yields the literal "." when both are absent, and Discover, Crawl and role
// search all pass frequently-null fields. buildFitPrompt renders
// company_description raw, so "." reached the model as the company's
// description.
describe("an absent company context composes an empty description, not a period", () => {
  test("no context at all", async () => {
    h.addJobResult = { job: { id: "job-1" } };

    await ingestRoles(OPTS);

    expect(insertedRow().company_description).toBe("");
    expect(vi.mocked(scoreFit).mock.calls[0][0].company_description).toBe("");
  });

  test("both fields present but null", async () => {
    h.addJobResult = { job: { id: "job-1" } };

    await ingestRoles({ ...OPTS, companyContext: { tagline: null, traction: null } });

    expect(insertedRow().company_description).toBe("");
  });

  test("a tagline with no traction carries no trailing separator", async () => {
    h.addJobResult = { job: { id: "job-1" } };

    await ingestRoles({ ...OPTS, companyContext: { tagline: "Data enrichment" } });

    expect(insertedRow().company_description).toBe("Data enrichment");
  });

  test("traction with no tagline carries no leading separator", async () => {
    h.addJobResult = { job: { id: "job-1" } };

    await ingestRoles({ ...OPTS, companyContext: { traction: "Series B" } });

    expect(insertedRow().company_description).toBe("Series B");
  });
});

// The structural guard. Two hand-maintained lists compared against each other
// would be the "copies of themselves" failure lib/rescore-scope.ts:29-35 warns
// about, so this captures addJob's actual argument and checks the rescore's
// own column list against it.
describe("every column a rescore reads is written at ingest", () => {
  test("the exempt columns are all real scoring inputs", () => {
    for (const column of INGEST_EXEMPT_COLUMNS) {
      expect(SCORING_INPUT_COLUMNS).toContain(column);
    }
  });

  test("ingest writes every non-exempt scoring input", async () => {
    h.addJobResult = { job: { id: "job-1" } };

    await ingestRoles({
      ...OPTS,
      companyContext: { tagline: "Data enrichment", traction: "Series B" },
    });

    const written = Object.keys(insertedRow());
    const required = SCORING_INPUT_COLUMNS.filter(
      (c) => !(INGEST_EXEMPT_COLUMNS as readonly string[]).includes(c)
    );
    expect(required.filter((c) => !written.includes(c))).toEqual([]);
  });
});

// Part 2: the extraction's new fields reach the row. `department` is what
// takes that column out of INGEST_EXEMPT_COLUMNS — ingest passed the literal
// "" to scoreFit and wrote nothing, so the column had no producer at all.
describe("ingest stores the posting's own words", () => {
  const detailed: Role = {
    ...ROLE,
    requirements: ["5+ years running the stack", "SQL"],
    nice_to_haves: ["Python"],
    department: "Revenue Operations",
  };

  test("requirements and nice-to-haves are stored in the posting column", async () => {
    h.addJobResult = { job: { id: "job-1" } };

    await ingestRoles({ ...OPTS, roles: [detailed] });

    expect(insertedRow().posting).toEqual({
      requirements: ["5+ years running the stack", "SQL"],
      niceToHaves: ["Python"],
    });
  });

  test("the department the posting names is stored on its own column", async () => {
    h.addJobResult = { job: { id: "job-1" } };

    await ingestRoles({ ...OPTS, roles: [detailed] });

    expect(insertedRow().department).toBe("Revenue Operations");
  });

  // Same drift this part's sibling fixes for key_skills: the column a rescore
  // reads back must be the value the first score saw.
  test("the stored department is the one scoreFit was given", async () => {
    h.addJobResult = { job: { id: "job-1" } };

    await ingestRoles({ ...OPTS, roles: [detailed] });

    expect(vi.mocked(scoreFit).mock.calls[0][0].department).toBe("Revenue Operations");
  });

  // A model that omits them must still write a real value: `posting is null`
  // is the backfill's "thin" predicate, so a row stored with undefined lists
  // would be re-enriched forever, and `department: undefined` would leave the
  // column with no producer again.
  test("a response omitting them stores empty lists, not undefined", async () => {
    h.addJobResult = { job: { id: "job-1" } };

    await ingestRoles(OPTS);

    expect(insertedRow().posting).toEqual({ requirements: [], niceToHaves: [] });
    expect(insertedRow().department).toBeNull();
    expect(vi.mocked(scoreFit).mock.calls[0][0].department).toBe("");
  });
});

// The ordering question, asked plainly: why should a role reach /roles scored
// from a search summary when the posting itself is one fetch away? The fit
// score is computed HERE, so reading after the fact means paying three times —
// score, read, rescore — for what one ordering gets right once.
describe("a role's posting is read before it is scored", () => {
  const LIVE = { ...ROLE, job_url: "https://clay.com/careers/1" };

  beforeEach(() => {
    h.addJobResult = { job: { id: "job-1" } };
    h.read = {
      kind: "read",
      detail: { requirements: ["5 years of SQL"], niceToHaves: ["Python"] },
      department: "Revenue Operations",
      employer: "",
      summary: "Runs the revenue stack.",
      empty: false,
    };
  });

  test("what the posting says is what scoreFit is given", async () => {
    await ingestRoles({ ...OPTS, roles: [LIVE] });

    const scored = vi.mocked(scoreFit).mock.calls[0][0];
    expect(scored.key_skills).toBe("Runs the revenue stack.");
    expect(scored.department).toBe("Revenue Operations");
  });

  test("the stored row carries the read, stamped, so no backfill repeats it", async () => {
    await ingestRoles({ ...OPTS, roles: [LIVE] });

    expect(insertedRow().posting).toMatchObject({
      requirements: ["5 years of SQL"],
      niceToHaves: ["Python"],
    });
    expect((insertedRow().posting as { enrichedAt?: string }).enrichedAt).toBeTruthy();
  });

  // Ordering, not just occurrence: a read that lands after the score is the
  // defect this change exists to remove.
  test("the read happens BEFORE the score, not alongside it", async () => {
    await ingestRoles({ ...OPTS, roles: [LIVE] });

    expect(vi.mocked(readPosting).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(scoreFit).mock.invocationCallOrder[0]
    );
  });

  // Unreadable is the COMMON case (a JS shell on a vendor with no honest board
  // API), and it must not block ingest: the role still lands, still scores on
  // the extraction's own summary, and stays in the backfill's queue because
  // nothing stamped it.
  test("an unreadable posting still ingests, unstamped, on the extraction's summary", async () => {
    h.read = { kind: "unreadable" };

    await ingestRoles({ ...OPTS, roles: [LIVE] });

    expect(insertedRow().key_skills).toBe(ROLE.description_summary);
    expect((insertedRow().posting as { enrichedAt?: string }).enrichedAt).toBeUndefined();
    expect(vi.mocked(scoreFit)).toHaveBeenCalledTimes(1);
  });

  test("a role that was already dead is never read — there is nothing to apply for", async () => {
    h.urlStatus = "dead";

    await ingestRoles({ ...OPTS, roles: [LIVE] });

    expect(vi.mocked(readPosting)).not.toHaveBeenCalled();
  });

  test("a role with no link at all is never read", async () => {
    await ingestRoles({ ...OPTS, roles: [{ ...ROLE, job_url: "" }] });

    expect(vi.mocked(readPosting)).not.toHaveBeenCalled();
  });

  // Railway closes a request that transfers no data for 300s, and the crawler
  // gets ONE request per company. A company posting thirty new roles must not
  // turn one crawl into thirty fetches and thirty model calls; the rest stay
  // unread and the Enrich button covers them.
  test("only the first few roles of a big batch are read", async () => {
    const many = Array.from({ length: MAX_INGEST_READS + 4 }, (_, i) => ({
      ...LIVE,
      role_title: `RevOps Manager ${i}`,
    }));

    await ingestRoles({ ...OPTS, roles: many });

    expect(vi.mocked(readPosting)).toHaveBeenCalledTimes(MAX_INGEST_READS);
    expect(vi.mocked(scoreFit)).toHaveBeenCalledTimes(many.length);
  });
});

// The cutoff, applied where the score is first computed. Ten for ten, every 1
// and 2 the user ever touched was dismissed, so keeping them New costs a
// rescore and a posting read and earns nothing.
describe("a role that reads weak is filed away, not left New", () => {
  const LIVE = { ...ROLE, job_url: "https://clay.com/careers/1" };

  beforeEach(() => {
    h.addJobResult = { job: { id: "job-1" } };
    h.read = {
      kind: "read",
      detail: { requirements: ["5 years of SQL"], niceToHaves: [] },
      department: "RevOps",
      employer: "",
      summary: "Runs the stack.",
      empty: false,
    };
  });

  test("a 2 that was actually read is moved to the user's first terminal status", async () => {
    h.score = 2;

    await ingestRoles({ ...OPTS, roles: [LIVE] });

    expect(vi.mocked(updateJob).mock.calls[0][1]).toMatchObject({
      fit_score: 2,
      status: "Not Interested",
    });
  });

  test("a 3 is left alone", async () => {
    h.score = 3;

    await ingestRoles({ ...OPTS, roles: [LIVE] });

    expect(vi.mocked(updateJob).mock.calls[0][1].status).toBeUndefined();
  });

  // The guard that keeps this fair: a role past ingest's per-run read budget is
  // scored on the extraction's summary, and a blind 2 is not evidence of a weak
  // role. It stays New and stays in the enrich queue.
  test("a 2 scored WITHOUT its posting is left New for the backfill to read", async () => {
    h.score = 2;
    h.read = { kind: "unreadable" };

    await ingestRoles({ ...OPTS, roles: [LIVE] });

    expect(vi.mocked(updateJob).mock.calls[0][1].status).toBeUndefined();
  });
});

// Measured 2026-09-07: three rows were stored as "basten" for Baseten, which
// normalizeCompanyName treats as a different employer — a second Discover card,
// a board-slug guess that cannot resolve, and a watchlist that never matches.
describe("the employer's own spelling of its name wins", () => {
  const LIVE = { ...ROLE, job_url: "https://clay.com/careers/1" };

  test("a misspelled company is stored the way the employer spells it", async () => {
    h.addJobResult = { job: { id: "job-1" } };
    h.read = {
      kind: "read",
      detail: { requirements: [], niceToHaves: [] },
      department: "",
      employer: "Baseten",
      summary: "Runs the stack.",
      empty: false,
    };

    await ingestRoles({ ...OPTS, company: "basten", roles: [LIVE] });

    expect(insertedRow().company).toBe("Baseten");
  });

  test("a differently-worded name is left alone, not renamed", async () => {
    h.addJobResult = { job: { id: "job-1" } };
    h.read = {
      kind: "read",
      detail: { requirements: [], niceToHaves: [] },
      department: "",
      employer: "Fireworks",
      summary: "Runs the stack.",
      empty: false,
    };

    await ingestRoles({ ...OPTS, company: "Fireworks AI", roles: [LIVE] });

    expect(insertedRow().company).toBe("Fireworks AI");
  });
});

// Step 3 of the verifiable-sourcing spec. Measured 2026-09-07: Role Search made
// 133 of 195 rows and owns 46 of the 59 unread-and-open ones, against the
// crawl's 12. The read budget that exists to keep ONE cron request inside
// Railway's 300s edge timeout was silently rationing the path that produces
// four fifths of the table — and that path is a user waiting on their own
// response, with no cron timeout to respect.
describe("a caller may raise or lower how many postings one ingest reads", () => {
  const LIVE = { ...ROLE, job_url: "https://clay.com/careers/1" };
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ ...LIVE, role_title: `RevOps Manager ${i}` }));

  beforeEach(() => {
    h.addJobResult = { job: { id: "job-1" } };
    h.read = {
      kind: "read",
      detail: { requirements: ["SQL"], niceToHaves: [] },
      department: "",
      employer: "",
      summary: "Runs the stack.",
      empty: false,
    };
  });

  test("a higher budget reads more of one run's roles", async () => {
    await ingestRoles({ ...OPTS, roles: many(12), maxReads: 12 });

    expect(vi.mocked(readPosting)).toHaveBeenCalledTimes(12);
  });

  // The default is unchanged, which is what keeps the crawler inside its
  // request: a caller that says nothing gets the cron-safe number.
  test("saying nothing keeps the crawler's bound", async () => {
    await ingestRoles({ ...OPTS, roles: many(12) });

    expect(vi.mocked(readPosting)).toHaveBeenCalledTimes(MAX_INGEST_READS);
  });

  // A posting the caller already read costs NOTHING from the budget — it is
  // already held, and re-reading it would spend a second fetch and a second
  // billed call to learn the same thing.
  test("a pre-read posting is used and does not consume the budget", async () => {
    const preRead = { [LIVE.job_url]: h.read } as Record<string, typeof h.read>;

    await ingestRoles({ ...OPTS, roles: [LIVE], preRead, maxReads: 0 });

    expect(vi.mocked(readPosting)).not.toHaveBeenCalled();
    expect((insertedRow().posting as { enrichedAt?: string }).enrichedAt).toBeTruthy();
  });
});

// Found in production 2026-09-07: 15 rows whose "posting" was a job board's
// SEARCH page, and companies like "Confidential (via CSG Talent)". They scored
// 2-4 and sat in the open pipeline looking like work, and no sourcing
// improvement could ever reach them — there is no posting behind a query.
describe("a search page is not a role, and a description is not an employer", () => {
  test("a role whose link is a job-board query is never stored", async () => {
    h.addJobResult = { job: { id: "job-1" } };

    const res = await ingestRoles({
      ...OPTS,
      roles: [{ ...ROLE, job_url: "https://www.indeed.com/q-npi-manager-jobs.html" }],
    });

    expect(vi.mocked(addJob)).not.toHaveBeenCalled();
    expect(res.added).toEqual([]);
  });

  test("a placeholder company is never stored", async () => {
    h.addJobResult = { job: { id: "job-1" } };

    await ingestRoles({ ...OPTS, company: "Confidential (via CSG Talent)", roles: [ROLE] });

    expect(vi.mocked(addJob)).not.toHaveBeenCalled();
  });

  // The rejection must not cost a read or a score — those are the two things
  // that spend money, and a row that will not be stored must spend neither.
  test("a rejected role costs no read and no score", async () => {
    await ingestRoles({
      ...OPTS,
      roles: [{ ...ROLE, job_url: "https://www.ziprecruiter.com/Jobs/Industrial-Coatings" }],
    });

    expect(vi.mocked(readPosting)).not.toHaveBeenCalled();
    expect(vi.mocked(scoreFit)).not.toHaveBeenCalled();
  });

  test("a real role at a real company is unaffected", async () => {
    h.addJobResult = { job: { id: "job-1" } };

    const res = await ingestRoles(OPTS);

    expect(res.added).toEqual([ROLE]);
  });
});
