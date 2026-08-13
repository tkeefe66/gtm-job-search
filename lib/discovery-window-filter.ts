import type { DateRange } from "@/app/actions/discover";

// Pure presentation logic behind the Discover tab's window filter (the chips
// that let a user see "recent companies vs older" among ALREADY-CACHED
// results). This is deliberately separate from `dateRange`, the selector
// that controls what a NEW search asks Claude for — one picks a fetch
// window, the other slices what's already on screen. Nothing here triggers
// a fetch.

export type WindowFilter = DateRange | "all";

export interface WindowFilterOption {
  value: WindowFilter;
  label: string;
  count: number;
}

// Builds the filter-chip list: "All" first (count = total items), then one
// chip per date range that actually has at least one item in `ranges`, in
// the same oldest-last order as `rangeOrder` (Discover.tsx's
// DATE_RANGE_OPTIONS). A range nobody has searched yet — or that returned
// zero results — gets no chip; an empty chip for a range that was never run
// would be noise, not a real choice.
export function buildWindowFilterOptions(
  ranges: DateRange[],
  rangeOrder: { value: DateRange; label: string }[]
): WindowFilterOption[] {
  const counts = new Map<DateRange, number>();
  for (const r of ranges) counts.set(r, (counts.get(r) ?? 0) + 1);

  const options: WindowFilterOption[] = [
    { value: "all", label: "All", count: ranges.length },
  ];
  for (const { value, label } of rangeOrder) {
    const count = counts.get(value) ?? 0;
    if (count > 0) options.push({ value, label, count });
  }
  return options;
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
