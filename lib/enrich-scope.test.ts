import { describe, expect, test } from "vitest";

import {
  DEFAULT_ENRICH_LIMIT,
  MAX_ENRICH_LIMIT,
  clampEnrichLimit,
  enrichBatch,
  enrichGate,
  thinJobs,
} from "./enrich-scope";
import { DEFAULT_STATUSES } from "./job-statuses";
import type { Job } from "./types";

const board = { vendor: "greenhouse" as const, slug: "clay" };

// The guardrail table in docs/superpowers/specs/2026-09-07-posting-detail-design.md.
// Enriching against a wrong URL writes fiction into the row, which is worse
// than leaving it thin, so the rule is POSITIVE EVIDENCE OF WRONGNESS.
describe("what a link's verification permits", () => {
  test("an aggregator link is resolved to the employer first, whatever the board said", () => {
    // The correction the spec records: verifyPostingLink answers
    // `notApplicable` for BOTH a company careers site and every aggregator
    // link, so reading that as "proceed" would enrich from a reseller's stale
    // copy — worse than a wrong ATS link, because a reseller answers 200 with
    // plausible content long after the req closed.
    expect(enrichGate("aggregator", { kind: "notApplicable" })).toEqual({ kind: "resolve" });
  });

  test("a company careers site proceeds", () => {
    expect(enrichGate("other", { kind: "notApplicable" })).toEqual({ kind: "proceed" });
  });

  test("a listed posting proceeds", () => {
    expect(enrichGate("ats", { kind: "listed", ...board })).toEqual({ kind: "proceed" });
  });

  test("a board we could not read says nothing, so the row proceeds", () => {
    expect(enrichGate("ats", { kind: "unreachable", ...board })).toEqual({ kind: "proceed" });
  });

  test("a relink is repaired first and enriched against the corrected URL", () => {
    expect(
      enrichGate("ats", { kind: "relink", ...board, url: "https://x/posting/2" })
    ).toEqual({ kind: "relink", url: "https://x/posting/2" });
  });

  test("a posting absent from its own board is blocked, with the reason", () => {
    expect(enrichGate("ats", { kind: "absent", ...board, url: "https://x" })).toEqual({
      kind: "blocked",
      reason: "absent",
    });
  });

  test("an undecidable board blocks under its own reason", () => {
    for (const reason of ["ambiguous", "empty"] as const) {
      expect(enrichGate("ats", { kind: "unclear", ...board, url: "https://x", reason })).toEqual({
        kind: "blocked",
        reason,
      });
    }
  });

  test("a row with no readable link at all is blocked, never fetched", () => {
    expect(enrichGate(null, { kind: "notApplicable" })).toEqual({
      kind: "blocked",
      reason: "unresolved",
    });
  });
});

const job = (over: Partial<Job>): Job =>
  ({
    id: "j1",
    company: "Clay",
    role_title: "RevOps Manager",
    status: "New",
    job_url: "https://example.com/jobs/1",
    posting: null,
    never_live: false,
    ...over,
  }) as Job;

// "Thin" is `posting is null` and a non-terminal status — the same filter
// repairJobLinks uses, for the same reason: a role the user already rejected
// must not cost a fetch and a model call.
describe("which rows a backfill is for", () => {
  test("a row with no posting detail is thin", () => {
    expect(thinJobs([job({})], DEFAULT_STATUSES).map((j) => j.id)).toEqual(["j1"]);
  });

  test("a row whose posting has been READ is not — see the stamp rule below", () => {
    const enriched = job({
      posting: { requirements: [], niceToHaves: [], enrichedAt: "2026-09-07T10:00:00.000Z" },
    });

    expect(thinJobs([enriched], DEFAULT_STATUSES)).toEqual([]);
  });

  test("a terminal row is not, however thin", () => {
    expect(thinJobs([job({ status: "Posting Closed" })], DEFAULT_STATUSES)).toEqual([]);
  });

  test("a row predating the column arrives with no key at all and is still thin", () => {
    const legacy = job({});
    delete (legacy as { posting?: unknown }).posting;

    expect(thinJobs([legacy], DEFAULT_STATUSES).map((j) => j.id)).toEqual(["j1"]);
  });

  test("a row with no link is skipped — there is nothing to fetch", () => {
    expect(thinJobs([job({ job_url: null })], DEFAULT_STATUSES)).toEqual([]);
  });
});

// The limit arrives from a client component, and the whole point of the bound
// is that no single call can run away — one fetch plus one model call per row,
// inside Railway's 300s no-data edge timeout.
describe("no single enrich call can run away", () => {
  test("a missing limit takes the default", () => {
    expect(clampEnrichLimit(undefined)).toBe(DEFAULT_ENRICH_LIMIT);
    expect(clampEnrichLimit(null)).toBe(DEFAULT_ENRICH_LIMIT);
  });

  test("an unusable number takes the default rather than erroring", () => {
    expect(clampEnrichLimit(Number.NaN)).toBe(DEFAULT_ENRICH_LIMIT);
  });

  test("an oversized limit is capped", () => {
    expect(clampEnrichLimit(10_000)).toBe(MAX_ENRICH_LIMIT);
  });

  test("zero and negatives become one, not zero — a call that touches nothing loops forever", () => {
    expect(clampEnrichLimit(0)).toBe(1);
    expect(clampEnrichLimit(-5)).toBe(1);
  });

  test("the default is smaller than the rescore's, because each row also fetches", () => {
    expect(DEFAULT_ENRICH_LIMIT).toBeLessThanOrEqual(MAX_ENRICH_LIMIT);
  });
});

const thin = (id: string): Job => job({ id });

// Why a CURSOR and not the rescore's passStartedAt: an enriched row stops
// matching `posting is null`, but a BLOCKED one never does. Paging by
// "re-read the thin rows" would hand every later batch the same blocked rows
// forever — each costing a board lookup, and the pass never draining.
describe("paging past the rows a pass has already decided", () => {
  test("the first batch takes the lowest ids and reports what is left", () => {
    const res = enrichBatch([thin("c"), thin("a"), thin("b")], DEFAULT_STATUSES, {
      limit: 2,
    });

    expect(res.batch.map((j) => j.id)).toEqual(["a", "b"]);
    expect(res.remaining).toBe(1);
    expect(res.cursor).toBe("b");
  });

  test("the next batch starts after the cursor, blocked rows included", () => {
    const res = enrichBatch([thin("a"), thin("b"), thin("c")], DEFAULT_STATUSES, {
      limit: 2,
      cursor: "b",
    });

    expect(res.batch.map((j) => j.id)).toEqual(["c"]);
    expect(res.remaining).toBe(0);
  });

  test("a drained pass returns no cursor, so the loop cannot restart itself", () => {
    const res = enrichBatch([thin("a")], DEFAULT_STATUSES, { limit: 5, cursor: "a" });

    expect(res.batch).toEqual([]);
    expect(res.remaining).toBe(0);
    expect(res.cursor).toBeNull();
  });

  test("rows that are not thin are never counted as remaining work", () => {
    const done = job({
      id: "z",
      posting: { requirements: [], niceToHaves: [], enrichedAt: "2026-09-07T10:00:00.000Z" },
    });

    const res = enrichBatch([thin("a"), done], DEFAULT_STATUSES, { limit: 1 });

    expect(res.remaining).toBe(0);
  });
});

// The predicate had a silent hole, found by asking what happens to roles found
// AFTER this shipped. Ingest always writes `posting` — deliberately, so a row
// the model had nothing for is not re-billed forever — so `posting is null`
// made every newly ingested role permanently ineligible for enrichment,
// however thin its content. The row LOOKED enriched.
//
// The stamp is the honest question: has anyone read the posting ITSELF? Only
// the enrich path writes enrichedAt, and ingest's extraction-derived detail is
// second-hand — one search prompt covering ten roles, not the posting page.
describe("thin means nobody has read the posting itself", () => {
  const withPosting = (posting: Record<string, unknown> | null) =>
    job({ posting: posting as never });

  test("a row ingest wrote is still thin — its detail came from a search, not the page", () => {
    const ingested = withPosting({ requirements: ["SQL"], niceToHaves: [] });

    expect(thinJobs([ingested], DEFAULT_STATUSES).map((j) => j.id)).toEqual(["j1"]);
  });

  test("a row the backfill read is not thin", () => {
    const read = withPosting({
      requirements: [],
      niceToHaves: [],
      enrichedAt: "2026-09-07T10:00:00.000Z",
    });

    expect(thinJobs([read], DEFAULT_STATUSES)).toEqual([]);
  });

  test("a row predating the column is thin, as it always was", () => {
    expect(thinJobs([withPosting(null)], DEFAULT_STATUSES).map((j) => j.id)).toEqual(["j1"]);
  });

  // Otherwise a garbage stamp permanently excludes the row from the one pass
  // that could fix it — the same direction every other stamp check in this
  // repo chooses.
  test("an unparseable stamp does not count as having been read", () => {
    const bogus = withPosting({ requirements: [], niceToHaves: [], enrichedAt: "whenever" });

    expect(thinJobs([bogus], DEFAULT_STATUSES).map((j) => j.id)).toEqual(["j1"]);
  });
});
