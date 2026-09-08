import { describe, expect, test } from "vitest";

import {
  EMPTY_POSTING_DETAIL,
  hasPostingBeenRead,
  latestEnrichedAt,
  postingDetailFrom,
} from "./posting-detail";

// The repair-don't-reject contract resolveProfile and resolveStatuses already
// establish, applied to the extraction's new fields. Nothing normalizes a
// model's role array — every path casts `parsed as Role[]` — so this is the
// only thing standing between a prose answer and `undefined` in the jsonb.
describe("postingDetailFrom repairs whatever the model returned", () => {
  test("a well-formed role carries both lists through", () => {
    const detail = postingDetailFrom({
      requirements: ["5+ years in the field", "SQL"],
      nice_to_haves: ["Python"],
    });

    expect(detail.requirements).toEqual(["5+ years in the field", "SQL"]);
    expect(detail.niceToHaves).toEqual(["Python"]);
  });

  test("omitted fields become empty lists, never undefined", () => {
    const detail = postingDetailFrom({});

    expect(detail.requirements).toEqual([]);
    expect(detail.niceToHaves).toEqual([]);
  });

  test("prose where a list was asked for becomes an empty list", () => {
    const detail = postingDetailFrom({
      requirements: "The posting asks for five years of experience",
      nice_to_haves: null,
    });

    expect(detail.requirements).toEqual([]);
    expect(detail.niceToHaves).toEqual([]);
  });

  test("non-string and blank entries are dropped, the rest trimmed", () => {
    const detail = postingDetailFrom({
      requirements: ["  SQL  ", "", "   ", 7, null, "Python"],
    });

    expect(detail.requirements).toEqual(["SQL", "Python"]);
  });

  // Every returned detail is fresh, for the same reason resolveProfile never
  // returns a reference into DEFAULT_PROFILE: a caller that pushes onto one
  // would corrupt the module-level constant for the life of the process.
  test("the empty detail is never returned by reference", () => {
    const detail = postingDetailFrom({});

    detail.requirements.push("mutated");

    expect(EMPTY_POSTING_DETAIL.requirements).toEqual([]);
    expect(postingDetailFrom({}).requirements).toEqual([]);
  });
});

// Half of the enrichment rescore offer's gate (the other half is the
// `enrich_rescored_at` stamp). Reading it off the rows the page already has
// avoids a second query and, more importantly, keeps the comparison the offer
// makes out of SQL, where no test in this repo could execute it.
describe("latestEnrichedAt finds the newest backfill write", () => {
  const at = (enrichedAt?: string) => ({
    posting: enrichedAt ? { requirements: [], niceToHaves: [], enrichedAt } : null,
  });

  test("the newest stamp wins, whatever order the rows arrive in", () => {
    expect(
      latestEnrichedAt([
        at("2026-09-01T00:00:00.000Z"),
        at("2026-09-07T00:00:00.000Z"),
        at("2026-09-03T00:00:00.000Z"),
      ])
    ).toBe("2026-09-07T00:00:00.000Z");
  });

  test("rows ingest wrote carry no stamp and are not evidence", () => {
    expect(latestEnrichedAt([{ posting: { requirements: [], niceToHaves: [] } }])).toBeNull();
  });

  test("a table with nothing enriched returns null", () => {
    expect(latestEnrichedAt([at(), at()])).toBeNull();
  });

  test("an unparseable stamp is ignored rather than winning by string order", () => {
    expect(latestEnrichedAt([at("2026-09-01T00:00:00.000Z"), at("whenever")])).toBe(
      "2026-09-01T00:00:00.000Z"
    );
  });
});

// "Readable" as a first-class state. A role scored 4 from a real posting and a
// role scored 4 from a job title look identical on /roles, and the second is a
// guess — measured 2026-09-07, only 3 of 58 rows scored 4-or-better had a JD.
describe("hasPostingBeenRead", () => {
  test("a row the posting itself was read for", () => {
    expect(
      hasPostingBeenRead({
        posting: { requirements: [], niceToHaves: [], enrichedAt: "2026-09-07T10:00:00.000Z" },
      })
    ).toBe(true);
  });

  // Ingest writes `posting` from the SEARCH extraction even when nobody read
  // the page, so the column's presence is not the question — the stamp is.
  test("a row carrying only the extraction's guess has not been read", () => {
    expect(hasPostingBeenRead({ posting: { requirements: ["SQL"], niceToHaves: [] } })).toBe(false);
  });

  test("a row predating the column has not been read", () => {
    expect(hasPostingBeenRead({ posting: null })).toBe(false);
    expect(hasPostingBeenRead({})).toBe(false);
  });

  test("an unparseable stamp does not count as read", () => {
    expect(
      hasPostingBeenRead({ posting: { requirements: [], niceToHaves: [], enrichedAt: "soon" } })
    ).toBe(false);
  });
});
