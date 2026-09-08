import { describe, expect, test } from "vitest";

import { postingDetailFrom, EMPTY_POSTING_DETAIL } from "./posting-detail";

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
