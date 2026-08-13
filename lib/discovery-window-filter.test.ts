import { describe, expect, test } from "vitest";
import {
  fetchTargetFor,
  buildWindowFilterOptions,
  filterByWindow,
  type WindowFilterOption,
} from "./discovery-window-filter";
import type { DateRange } from "@/app/actions/discover";

function labelsOf(options: WindowFilterOption[]): string[] {
  return options.map((o) => o.label);
}

const SEARCHABLE: { value: DateRange; label: string }[] = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "3m", label: "3 months" },
];
const LEGACY: { value: DateRange; label: string }[] = [
  { value: "6m", label: "6 months" },
  { value: "6-18m", label: "6\u201318 mo" },
];

describe("buildWindowFilterOptions", () => {
  test("always includes an All chip counting every item, even with none present", () => {
    // Catches an implementation that omits "All" or that counts only a
    // subset (e.g. counting distinct ranges instead of items).
    const options = buildWindowFilterOptions([], SEARCHABLE, LEGACY);
    expect(options.length).toBeGreaterThan(0);
    expect(options[0]).toEqual({ value: "all", label: "All", count: 0 });
  });

  test("a searchable range always gets a chip, even at zero — it is how you pick what to search", () => {
    const opts = buildWindowFilterOptions([], SEARCHABLE);
    expect(opts.map((o) => o.value)).toEqual(["all", "7d", "30d", "3m"]);
    expect(opts.every((o) => o.count === 0)).toBe(true);
    expect(opts.length).toBe(4);
  });

  test("a retired range gets a chip only when it still holds cached results", () => {
    const withData = buildWindowFilterOptions(["6m", "6m", "7d"], SEARCHABLE, LEGACY);
    expect(withData.map((o) => o.value)).toContain("6m");
    expect(withData.find((o) => o.value === "6m")?.count).toBe(2);

    const withoutData = buildWindowFilterOptions(["7d"], SEARCHABLE, LEGACY);
    expect(withoutData.map((o) => o.value)).not.toContain("6m");
    expect(withoutData.map((o) => o.value)).not.toContain("6-18m");
  });

  test("retired chips sort after searchable ones", () => {
    const opts = buildWindowFilterOptions(["6m", "7d"], SEARCHABLE, LEGACY);
    expect(opts.map((o) => o.value)).toEqual(["all", "7d", "30d", "3m", "6m"]);
  });

  test("counts each range correctly rather than reporting a constant", () => {
    const options = buildWindowFilterOptions(
      ["7d", "6-18m", "6-18m", "6-18m", "3m"],
      SEARCHABLE,
      LEGACY
    );
    expect(options.length).toBeGreaterThan(1);
    expect(options).toEqual([
      { value: "all", label: "All", count: 5 },
      { value: "7d", label: "7 days", count: 1 },
      { value: "30d", label: "30 days", count: 0 },
      { value: "3m", label: "3 months", count: 1 },
      { value: "6-18m", label: "6\u201318 mo", count: 3 },
    ]);
  });

  test("orders chips by the supplied order, not by first-seen-in-input", () => {
    const options = buildWindowFilterOptions(["6-18m", "7d", "6m"], SEARCHABLE, LEGACY);
    expect(options.length).toBeGreaterThan(1);
    expect(labelsOf(options)).toEqual([
      "All",
      "7 days",
      "30 days",
      "3 months",
      "6 months",
      "6\u201318 mo",
    ]);
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

describe("fetchTargetFor", () => {
  test("a searchable selection is its own fetch target", () => {
    expect(fetchTargetFor("30d", SEARCHABLE, "7d")).toBe("30d");
    expect(fetchTargetFor("3m", SEARCHABLE, "7d")).toBe("3m");
  });

  test('"all" has no window of its own and falls back to the default', () => {
    expect(fetchTargetFor("all", SEARCHABLE, "7d")).toBe("7d");
    expect(fetchTargetFor("all", SEARCHABLE, "30d")).toBe("30d");
  });

  test("a retired window cannot be re-fetched and falls back", () => {
    // The bug this prevents: highlighting "6 months" and silently fetching it
    // anyway, against a range the app no longer offers.
    expect(fetchTargetFor("6m", SEARCHABLE, "7d")).toBe("7d");
    expect(fetchTargetFor("6-18m", SEARCHABLE, "7d")).toBe("7d");
  });

  test("the fallback is honored rather than hardcoded to 7d", () => {
    expect(fetchTargetFor("6m", SEARCHABLE, "3m")).toBe("3m");
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
