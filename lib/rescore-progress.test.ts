import { describe, expect, test } from "vitest";
import { DEFAULT_RESCORE_LIMIT } from "./rescore-scope";
import {
  DOLLARS_PER_RESCORE,
  maxRescoreBatches,
  rescoreCostDollars,
  rescoreSummary,
  shouldContinueRescore,
} from "./rescore-progress";

describe("rescoreCostDollars", () => {
  test("pins the per-row rate", () => {
    // The number the prompt quotes to the user before they spend money. A
    // units slip here (0.075, 0.00075) passes every proportionality test.
    expect(DOLLARS_PER_RESCORE).toBe(0.0075);
  });

  test("multiplies the row count by the per-row rate", () => {
    expect(rescoreCostDollars(100)).toBe(0.75);
  });

  test("rounds to whole cents", () => {
    // 44 * 0.0075 = 0.33 exactly in decimal, but 0.33000000000000007 in
    // floating point — unrounded this renders as a long tail.
    expect(rescoreCostDollars(44)).toBe(0.33);
    expect(rescoreCostDollars(7)).toBe(0.05); // 0.0525 rounds up
  });

  test("rounds rather than truncates", () => {
    // 0.0525 -> 0.05 above and 0.0575 -> 0.06 here. Math.floor would give
    // 0.05 for both, understating what the user is about to spend.
    expect(rescoreCostDollars(9)).toBe(0.07); // 0.0675
  });

  test("is zero for zero, negative, and non-finite counts", () => {
    expect(rescoreCostDollars(0)).toBe(0);
    expect(rescoreCostDollars(-5)).toBe(0);
    expect(rescoreCostDollars(Number.NaN)).toBe(0);
  });
});

describe("shouldContinueRescore", () => {
  test("continues while there is work left and the last batch made progress", () => {
    expect(shouldContinueRescore({ rescored: 25, remaining: 60 })).toBe(true);
  });

  test("stops when nothing is left", () => {
    expect(shouldContinueRescore({ rescored: 25, remaining: 0 })).toBe(false);
  });

  test("stops when a batch made no progress, even with rows remaining", () => {
    // The whole reason this function exists. A permanently failing row keeps
    // `remaining` above zero forever; looping on `remaining > 0` alone spends
    // a Claude call per row per pass until something times out.
    expect(shouldContinueRescore({ rescored: 0, remaining: 60 })).toBe(false);
  });

  test("stops when both are zero", () => {
    expect(shouldContinueRescore({ rescored: 0, remaining: 0 })).toBe(false);
  });
});

describe("maxRescoreBatches", () => {
  test("covers the row count with one batch of slack", () => {
    expect(maxRescoreBatches(100, 25)).toBe(5);
  });

  test("rounds a partial batch up", () => {
    expect(maxRescoreBatches(26, 25)).toBe(3);
    expect(maxRescoreBatches(1, 25)).toBe(2);
  });

  test("never returns less than one, so a rescore always runs once", () => {
    expect(maxRescoreBatches(0)).toBe(1);
    expect(maxRescoreBatches(-10)).toBe(1);
    expect(maxRescoreBatches(Number.NaN)).toBe(1);
  });

  test("defaults to the action's own batch size", () => {
    expect(maxRescoreBatches(100)).toBe(maxRescoreBatches(100, DEFAULT_RESCORE_LIMIT));
  });
});

describe("rescoreSummary", () => {
  test("a complete pass reports only what it did", () => {
    expect(rescoreSummary({ rescored: 12, failed: 0, remaining: 0 })).toBe(
      "Rescored 12 roles."
    );
  });

  test("a single role reads in the singular", () => {
    expect(rescoreSummary({ rescored: 1, failed: 0, remaining: 0 })).toBe(
      "Rescored 1 role."
    );
  });

  test("a partial pass is never presented as complete", () => {
    // The dishonesty this function exists to prevent: "Rescored 25 roles." is
    // the whole message a naive implementation returns here.
    const s = rescoreSummary({ rescored: 25, failed: 0, remaining: 60 });
    expect(s).toContain("60 still to do");
    expect(s).toContain("run Rescore again");
  });

  test("failures are named and separated from successes", () => {
    const s = rescoreSummary({ rescored: 20, failed: 5, remaining: 0 });
    expect(s).toContain("Rescored 20 roles");
    expect(s).toContain("5 could not be scored");
    expect(s).toContain("kept their old scores");
  });

  test("a batch that only failed does not claim any rescores", () => {
    const s = rescoreSummary({ rescored: 0, failed: 3, remaining: 3 });
    expect(s).toContain("No roles were rescored");
    expect(s).not.toContain("Rescored 0");
    expect(s).toContain("3 still to do");
  });

  test("nothing to do says so rather than reporting zeros", () => {
    expect(rescoreSummary({ rescored: 0, failed: 0, remaining: 0 })).toBe(
      "Nothing to rescore."
    );
  });
});
