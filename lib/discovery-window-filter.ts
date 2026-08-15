import type { DateRange } from "@/app/actions/discover";

// Pure logic behind the Discover tab's window filter chips.
//
// A chip does ONE thing: slice the already-loaded list. It does not choose
// what a new search asks for, and selecting one never fetches. What is
// fetchable is a fixed pair of buttons — see FETCHABLE_RANGES in
// lib/discovery-windows.ts.
//
// These were briefly fused: one chip row both filtered the view and named the
// Discover button's target, so the primary CTA changed under you as you
// filtered. Splitting them back apart is why `pinned` below no longer means
// "searchable" — a pinned chip is charted whether or not any button can fill
// it. 3m is exactly that case: charted at zero, deliberately unfetchable.
//
// `legacy` is the other asymmetry: a window can hold cached results while no
// longer being offered anywhere (6m and 6-18m were retired once the user
// decided they would never look that far back). Those results stay visible
// and filterable — they were paid for — they just cannot be re-fetched.

export type WindowFilter = DateRange | "all";

export interface WindowFilterOption {
  value: WindowFilter;
  label: string;
  count: number;
}

// Builds the chip list: "All" first (count = every item), then one chip per
// PINNED window — shown even at zero, so the row's shape stays stable as
// results come and go rather than reflowing under the cursor — then one chip
// per retired window that still holds cached results. A retired window with
// no data gets no chip: nothing can fill it and nothing is in it, so it would
// be a control that does nothing at all.
export function buildWindowFilterOptions(
  ranges: DateRange[],
  pinned: { value: DateRange; label: string }[],
  legacy: { value: DateRange; label: string }[] = []
): WindowFilterOption[] {
  const counts = new Map<DateRange, number>();
  for (const r of ranges) counts.set(r, (counts.get(r) ?? 0) + 1);

  const options: WindowFilterOption[] = [
    { value: "all", label: "All", count: ranges.length },
  ];
  for (const { value, label } of pinned) {
    options.push({ value, label, count: counts.get(value) ?? 0 });
  }
  for (const { value, label } of legacy) {
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
