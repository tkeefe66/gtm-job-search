import type { DateRange } from "@/app/actions/discover";

// Pure logic behind the Discover tab's single window selector.
//
// This was originally two controls — a "search window" that set what a NEW
// search asked for, and a separate filter over already-cached results. Two
// rows of near-identical chips read as redundant, so they are merged: one
// chip both slices the view and names what Discover will fetch next.
// Selecting a chip still never fetches; the Discover button does that.
//
// The two concepts do not overlap perfectly, which is what the "legacy"
// handling below is for: a window can hold cached results while no longer
// being offered as a search target (6m and 6-18m were retired once the user
// decided they would never look that far back). Those results stay visible
// and filterable — they were paid for — they just cannot be re-fetched.

export type WindowFilter = DateRange | "all";

export interface WindowFilterOption {
  value: WindowFilter;
  label: string;
  count: number;
}

// Builds the chip list: "All" first (count = every item), then one chip per
// searchable window — shown even at zero, because the chip is how you choose
// what to search, so hiding an empty one would make an un-run window
// unreachable — then one chip per retired window that still holds cached
// results. A retired window with no data gets no chip: it is neither
// searchable nor viewable, so it would be a dead control.
export function buildWindowFilterOptions(
  ranges: DateRange[],
  searchable: { value: DateRange; label: string }[],
  legacy: { value: DateRange; label: string }[] = []
): WindowFilterOption[] {
  const counts = new Map<DateRange, number>();
  for (const r of ranges) counts.set(r, (counts.get(r) ?? 0) + 1);

  const options: WindowFilterOption[] = [
    { value: "all", label: "All", count: ranges.length },
  ];
  for (const { value, label } of searchable) {
    options.push({ value, label, count: counts.get(value) ?? 0 });
  }
  for (const { value, label } of legacy) {
    const count = counts.get(value) ?? 0;
    if (count > 0) options.push({ value, label, count });
  }
  return options;
}

// Which window the Discover button will actually fetch, given what is
// selected. "All" has no window of its own, and a retired window cannot be
// re-fetched, so both fall back to the default. Returned rather than inferred
// at the call site so the button can label itself honestly — a button that
// says "Discover" while silently fetching a different window than the one
// highlighted is the kind of quiet mismatch this app has been bitten by.
export function fetchTargetFor(
  selected: WindowFilter,
  searchable: { value: DateRange }[],
  fallback: DateRange
): DateRange {
  if (selected === "all") return fallback;
  return searchable.some((s) => s.value === selected) ? selected : fallback;
}

// Filters range-tagged items down to the selected window. "all" (the
// default, matching pre-filter behavior exactly) returns every item
// unchanged.
export function filterByWindow<T extends { discovered_range: DateRange }>(
  items: T[],
  selected: WindowFilter
): T[] {
  if (selected === "all") return items;
  return items.filter((item) => item.discovered_range === selected);
}
