import { describe, expect, test } from "vitest";
import { estimateRunCost, formatEstimate, type EstimateInput, formatReadingCost, readingCostDollars, estimateModelCostDollars, rescoreCostDollars } from "./cost-estimate";

describe("provider-aware estimates", () => {
  const input = { titles: 10, locations: 1, stackTerms: 0, ceiling: null };
  test("prices normalized usage with each selected provider's own table", () => {
    const usage = { inputTokens: 1000000, cachedInputTokens: 1000000, outputTokens: 1000000, searches: 2, groundedRequests: 1 };
    expect(estimateModelCostDollars(usage, { provider: "openai" })).toBe(10.55);
    expect(estimateModelCostDollars(usage, { provider: "google" })).toBe(2.87);
  });
  test("unknown models cannot inherit a price for another model", () => {
    expect(() => estimateRunCost({ ...input, provider: "google", model: "unknown" })).toThrow(/model/i);
    expect(() => estimateModelCostDollars({ inputTokens: 1, cachedInputTokens: 0, outputTokens: 0, searches: 0 }, { model: "unknown" })).toThrow(/model/i);
  });
  test("Google run estimate charges one grounded prompt even for ten queries", () => {
    // 50k input + 1k output research; 50k input + 2.5k output scoring;
    // one $0.035 grounded prompt. Rounded separately at the pricing boundary.
    expect(estimateRunCost({ ...input, provider: "google" }).dollars).toBeCloseTo(0.09);
    expect(estimateRunCost({ ...input, provider: "openai" }).dollars).toBeCloseTo(0.48);
  });
  test("new-provider reading and rescore estimates do not use Anthropic prices", () => {
    expect(readingCostDollars(100, { provider: "openai" })).toBe(0.44);
    expect(readingCostDollars(100, { provider: "google" })).toBe(0.1);
    expect(rescoreCostDollars(100, { provider: "openai" })).toBe(0.48);
  });
  test("non-enforceable search limits are identified as assumptions", () => {
    expect(formatEstimate({ ...input, ceiling: 2, provider: "google" })).toContain("assuming 2 searches; not an enforced cap");
    expect(formatEstimate({ ...input, ceiling: 2, provider: "google" })).not.toContain("capped at");
    expect(formatEstimate({ ...input, ceiling: 2, provider: "openai" })).toContain("capped at 2");
  });
});

describe("estimateRunCost", () => {
  test("counts the title and stack grids separately", () => {
    const e = estimateRunCost({ titles: 13, locations: 3, stackTerms: 8, ceiling: null });
    expect(e.titleQueries).toBe(39);
    expect(e.stackQueries).toBe(24);
  });

  test("without a stored ceiling, the estimate applies the 32-search default", () => {
    // Mutation this catches: pricing the full grid when the server now applies
    // its default ceiling, which would overstate the cost shown in Settings.
    const e = estimateRunCost({ titles: 13, locations: 3, stackTerms: 8, ceiling: null });
    expect(e.searches).toBe(32);
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
    expect(e.dollars).toBeGreaterThan(0.9);
    expect(e.dollars).toBeLessThan(1.1);
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
    ).toBe("13 titles × 3 locations = 39 queries (default cap 32) · ~$0.99 per By Role run");
  });

  test("names the grid the price is actually for", () => {
    // 2 × 3 = 6 title queries against 20 × 3 = 60 stack queries, and
    // estimateRunCost prices the LARGER grid. Naming titles here would put "6
    // queries" beside a price for 60 searches — a line that contradicts
    // itself. The factors shown must multiply out to the priced grid.
    const s = formatEstimate({ titles: 2, locations: 3, stackTerms: 20, ceiling: null });
    expect(s).toContain("20 stack terms × 3 locations = 60 queries (default cap 32)");
    expect(s).not.toContain("= 6 queries");
  });

  test("the printed query count always equals the priced grid", () => {
    // Swept rather than spot-checked: whichever family dominates, the number
    // on the line and the number the dollars were computed from must agree.
    const cases: EstimateInput[] = [
      { titles: 13, locations: 3, stackTerms: 8, ceiling: null }, // title-driven
      { titles: 2, locations: 3, stackTerms: 20, ceiling: null }, // stack-driven
      { titles: 5, locations: 2, stackTerms: 5, ceiling: null }, // a tie
      { titles: 1, locations: 1, stackTerms: 1, ceiling: null },
    ];
    expect(cases.length).toBeGreaterThan(0);
    for (const input of cases) {
      const e = estimateRunCost(input);
      expect(formatEstimate(input)).toContain(
        `= ${e.grid} quer${e.grid === 1 ? "y" : "ies"}`
      );
    }
  });

  test("a tie between the grids reads as titles", () => {
    // Arbitrary but fixed: with both grids equal the price is the same either
    // way, and titles are the list the line sits under.
    const s = formatEstimate({ titles: 5, locations: 2, stackTerms: 5, ceiling: null });
    expect(s).toContain("5 titles × 2 locations = 10 queries");
  });

  test("states the cap when a ceiling cuts the grid down", () => {
    const s = formatEstimate({ titles: 13, locations: 3, stackTerms: 8, ceiling: 15 });
    expect(s).toBe(
      "13 titles × 3 locations = 39 queries (capped at 15) · ~$0.56 per By Role run"
    );
  });

  test("states the cap when the ceiling binds against the STACK grid", () => {
    // The case the old title-only line got most wrong: the ceiling (15) is
    // above the title grid (6) but well below the priced stack grid (60), so
    // the line used to report neither the real grid nor the cap while quoting
    // a capped price.
    const s = formatEstimate({ titles: 2, locations: 3, stackTerms: 20, ceiling: 15 });
    expect(s).toContain("20 stack terms × 3 locations = 60 queries (capped at 15)");
  });

  test("says nothing about a ceiling that does not bind", () => {
    const s = formatEstimate({ titles: 2, locations: 2, stackTerms: 2, ceiling: 100 });
    expect(s).not.toContain("capped");
  });

  test("states the default cap when no stored ceiling binds", () => {
    const s = formatEstimate({ titles: 13, locations: 3, stackTerms: 8, ceiling: null });
    expect(s).toContain("default cap 32");
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

// Reading a posting is a NON-SEARCH call, and this file had no vocabulary for
// one — so the enrich banner reported counts while the spend stayed invisible,
// and reads now happen inside every search too. Measured 2026-09-07: 12 enrich
// batches over ~50 rows cost 19¢, and 5 batches cost 5¢ — roughly half a cent
// per posting actually read.
describe("what reading postings costs", () => {
  test("nothing read is nothing spent", () => {
    expect(readingCostDollars(0)).toBe(0);
  });

  test("a batch is priced from the provider's own table, not a copy", () => {
    // Sanity, not precision: an order of magnitude wrong here shows the user a
    // number the meter disagrees with.
    const ten = readingCostDollars(10);
    expect(ten).toBeGreaterThan(0.01);
    expect(ten).toBeLessThan(0.5);
  });

  test("it scales with the rows actually read", () => {
    expect(readingCostDollars(20)).toBeCloseTo(readingCostDollars(10) * 2, 5);
  });

  test("the rendered figure always names dollars and cents", () => {
    expect(formatReadingCost(10)).toMatch(/^~\$\d+\.\d{2}$/);
  });
})
