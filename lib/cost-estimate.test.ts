import { describe, expect, test } from "vitest";
import { estimateRunCost, formatEstimate } from "./cost-estimate";

describe("estimateRunCost", () => {
  test("counts the title and stack grids separately", () => {
    const e = estimateRunCost({ titles: 13, locations: 3, stackTerms: 8, ceiling: null });
    expect(e.titleQueries).toBe(39);
    expect(e.stackQueries).toBe(24);
  });

  test("without a ceiling, searches equal the larger grid", () => {
    const e = estimateRunCost({ titles: 13, locations: 3, stackTerms: 8, ceiling: null });
    expect(e.searches).toBe(39);
  });

  test("a ceiling caps the searches", () => {
    const e = estimateRunCost({ titles: 13, locations: 3, stackTerms: 8, ceiling: 15 });
    expect(e.searches).toBe(15);
  });

  test("a ceiling above the grid does not inflate the estimate", () => {
    const e = estimateRunCost({ titles: 2, locations: 2, stackTerms: 2, ceiling: 100 });
    expect(e.searches).toBe(4);
  });

  test("cost rises with the grid", () => {
    const small = estimateRunCost({ titles: 2, locations: 1, stackTerms: 2, ceiling: null });
    const big = estimateRunCost({ titles: 20, locations: 3, stackTerms: 8, ceiling: null });
    expect(big.dollars).toBeGreaterThan(small.dollars);
  });

  test("pins an absolute figure, not just a trend", () => {
    // A units typo (3 / 1_000 instead of 3 / 1_000_000, or DOLLARS_PER_SEARCH
    // at 0.1) passes every other test in this suite. This is the only one that
    // catches it.
    const e = estimateRunCost({ titles: 13, locations: 3, stackTerms: 8, ceiling: null });
    expect(e.dollars).toBeGreaterThan(1.0);
    expect(e.dollars).toBeLessThan(1.3);
  });

  test("an empty grid costs nothing", () => {
    const e = estimateRunCost({ titles: 0, locations: 3, stackTerms: 0, ceiling: null });
    expect(e.searches).toBe(0);
    expect(e.dollars).toBe(0);
  });
});

describe("formatEstimate", () => {
  test("renders the shipped defaults as one line", () => {
    expect(
      formatEstimate({ titles: 13, locations: 3, stackTerms: 8, ceiling: null })
    ).toBe("13 titles × 3 locations = 39 queries · ~$1.17 per By Role run");
  });

  test("shows the title grid, not the larger stack grid", () => {
    // 2 × 3 = 6 title queries against 20 × 3 = 60 stack queries. The two
    // numbers on the left multiply to 6, so showing 60 would be arithmetic
    // the user can see is wrong.
    const s = formatEstimate({ titles: 2, locations: 3, stackTerms: 20, ceiling: null });
    expect(s).toContain("2 titles × 3 locations = 6 queries");
  });

  test("states the cap when a ceiling cuts the grid down", () => {
    const s = formatEstimate({ titles: 13, locations: 3, stackTerms: 8, ceiling: 15 });
    expect(s).toBe(
      "13 titles × 3 locations = 39 queries (capped at 15) · ~$0.56 per By Role run"
    );
  });

  test("says nothing about a ceiling that does not bind", () => {
    const s = formatEstimate({ titles: 2, locations: 2, stackTerms: 2, ceiling: 100 });
    expect(s).not.toContain("capped");
  });

  test("says nothing about a cap when there is no ceiling", () => {
    const s = formatEstimate({ titles: 13, locations: 3, stackTerms: 8, ceiling: null });
    expect(s).not.toContain("capped");
  });

  test("singularizes each of the three counts", () => {
    const s = formatEstimate({ titles: 1, locations: 1, stackTerms: 1, ceiling: null });
    expect(s).toBe("1 title × 1 location = 1 query · ~$0.21 per By Role run");
  });

  test("always shows two decimal places", () => {
    const s = formatEstimate({ titles: 2, locations: 2, stackTerms: 2, ceiling: null });
    expect(s).toContain("~$0.29 per By Role run");
  });
});
