import { describe, expect, test } from "vitest";
import {
  FETCHABLE_RANGES,
  PINNED_CHIPS,
  LEGACY_RANGES,
  labelForRange,
} from "./discovery-windows";

// These three lists used to be two, and the Discover button derived what it
// would fetch from whichever chip was selected. They are now independent: the
// buttons say what is fetchable, the chips say what is charted. Independent
// lists drift, and this repo has been bitten by exactly that before (the
// compensation floor's boundary rule living in two files). The invariants
// below are what keeps a button from fetching into a window with no chip to
// see the results in.
describe("the fetchable and charted window lists agree", () => {
  test("every fetchable range is also a pinned chip", () => {
    const pinned = new Set(PINNED_CHIPS.map((c) => c.value));
    for (const { value } of FETCHABLE_RANGES) {
      expect(pinned.has(value)).toBe(true);
    }
  });

  test("no range is both pinned and legacy", () => {
    // A range in both lists would render two chips for one window.
    const pinned = new Set(PINNED_CHIPS.map((c) => c.value));
    for (const { value } of LEGACY_RANGES) {
      expect(pinned.has(value)).toBe(false);
    }
  });

  test("nothing fetchable has been retired to legacy", () => {
    const legacy = new Set(LEGACY_RANGES.map((c) => c.value));
    for (const { value } of FETCHABLE_RANGES) {
      expect(legacy.has(value)).toBe(false);
    }
  });

  test("the fetchable windows are exactly 7d and 30d", () => {
    // Pins the decision, so widening what a single click can bill is a
    // deliberate edit with a failing test, not a quiet one-line addition.
    expect(FETCHABLE_RANGES.map((r) => r.value)).toEqual(["7d", "30d"]);
  });

  test("3m is charted but not fetchable", () => {
    // The deliberate dead control: its chip stays visible at zero so the row
    // shape is stable, but no button can fill it.
    expect(PINNED_CHIPS.map((c) => c.value)).toContain("3m");
    expect(FETCHABLE_RANGES.map((r) => r.value)).not.toContain("3m");
  });
});

describe("labelForRange", () => {
  test("names every pinned and legacy window", () => {
    for (const { value, label } of [...PINNED_CHIPS, ...LEGACY_RANGES]) {
      expect(labelForRange(value)).toBe(label);
    }
  });

  test("falls back to the raw range rather than rendering undefined", () => {
    // @ts-expect-error deliberately outside DateRange
    expect(labelForRange("99y")).toBe("99y");
  });
});
