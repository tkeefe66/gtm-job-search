import { describe, expect, test } from "vitest";
import {
  buildWindowFilterOptions,
  filterByWindow,
  type WindowFilterOption,
} from "./discovery-window-filter";
import type { DateRange } from "@/app/actions/discover";

const RANGE_ORDER: { value: DateRange; label: string }[] = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "3m", label: "3 months" },
  { value: "6m", label: "6 months" },
  { value: "6-18m", label: "6–18 mo" },
];

function labelsOf(options: WindowFilterOption[]): string[] {
  return options.map((o) => o.label);
}

describe("buildWindowFilterOptions", () => {
  test("always includes an All chip counting every item, even with none present", () => {
    // Catches an implementation that omits "All" or that counts only a
    // subset (e.g. counting distinct ranges instead of items).
    const options = buildWindowFilterOptions([], RANGE_ORDER);
    expect(options.length).toBeGreaterThan(0);
    expect(options[0]).toEqual({ value: "all", label: "All", count: 0 });
  });

  test("omits chips for ranges that have zero items", () => {
    // Catches an implementation that emits a chip for every member of
    // rangeOrder regardless of whether any data exists for it — a range
    // that was never searched should produce no chip, not an empty one.
    const options = buildWindowFilterOptions(["7d", "7d"], RANGE_ORDER);
    expect(options.length).toBeGreaterThan(1);
    expect(labelsOf(options)).toEqual(["All", "7 days"]);
  });

  test("includes a chip for every range that has at least one item, with correct counts", () => {
    // Catches an implementation that miscounts (e.g. always 1) or drops a
    // present range.
    const options = buildWindowFilterOptions(
      ["7d", "6-18m", "6-18m", "6-18m", "3m"],
      RANGE_ORDER
    );
    expect(options.length).toBeGreaterThan(1);
    expect(options).toEqual([
      { value: "all", label: "All", count: 5 },
      { value: "7d", label: "7 days", count: 1 },
      { value: "3m", label: "3 months", count: 1 },
      { value: "6-18m", label: "6–18 mo", count: 3 },
    ]);
  });

  test("orders present-range chips oldest-last, matching rangeOrder, not input order", () => {
    // Catches an implementation that orders chips by first-seen-in-input
    // instead of following rangeOrder (7d -> 30d -> 3m -> 6m -> 6-18m).
    const options = buildWindowFilterOptions(["6-18m", "7d", "6m"], RANGE_ORDER);
    expect(options.length).toBeGreaterThan(1);
    expect(labelsOf(options)).toEqual(["All", "7 days", "6 months", "6–18 mo"]);
  });
});

describe("DateRange union", () => {
  test("pins the known members of DateRange", () => {
    // This Record is only assignable if it has exactly one key per member of
    // the DateRange union — no more, no fewer. If a future change adds or
    // removes a range in app/actions/discover.ts without updating this file
    // to match, `tsc` (run by `npm run build`, which typechecks every *.ts
    // file per tsconfig.json's `**/*.ts` include) fails on this line before
    // the app ships, forcing the change to be deliberate rather than an
    // accidental drift between the type and every place that assumes its
    // shape (this file, DATE_RANGE_OPTIONS in Discover.tsx, etc).
    const allRanges: Record<DateRange, true> = {
      "7d": true,
      "30d": true,
      "3m": true,
      "6m": true,
      "6-18m": true,
    };
    expect(Object.keys(allRanges).sort()).toEqual(
      ["7d", "30d", "3m", "6m", "6-18m"].sort()
    );
  });
});

describe("filterByWindow", () => {
  const items = [
    { company: "A", discovered_range: "7d" as DateRange },
    { company: "B", discovered_range: "6-18m" as DateRange },
    { company: "C", discovered_range: "7d" as DateRange },
  ];

  test('"all" returns every item unchanged, matching pre-filter behavior', () => {
    // Catches an implementation that treats "all" as a literal range value
    // and filters it out, returning an empty (or wrong) list by default.
    const result = filterByWindow(items, "all");
    expect(result.length).toBe(3);
    expect(result).toEqual(items);
  });

  test("a specific range keeps only matching items", () => {
    // Catches an implementation that ignores `selected` and always returns
    // everything (a broken filter that never narrows the list).
    const result = filterByWindow(items, "7d");
    expect(result.length).toBe(2);
    expect(result.every((i) => i.discovered_range === "7d")).toBe(true);
  });

  test("a range present in rangeOrder but absent from items returns an empty list, not everything", () => {
    // Catches an implementation that falls back to returning all items when
    // no match is found instead of correctly returning none.
    const result = filterByWindow(items, "3m");
    expect(result).toEqual([]);
  });
});
