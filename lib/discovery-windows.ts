import type { DateRange } from "@/app/actions/discover";

// The Discover tab's window lists, extracted from components/Discover.tsx so
// the invariants between them can be tested. The component is a client
// component with no test harness in this repo (vitest runs environment:
// "node", no jsdom), so anything left inline there is verified by reading
// only.
//
// Two INDEPENDENT concepts, deliberately not one:
//
//   FETCHABLE_RANGES — what a button can search. Each entry bills a Claude
//   web-search run, so this list is the ceiling on what one click can spend.
//
//   PINNED_CHIPS — what the filter row always charts, even at zero. A chip
//   slices the already-loaded list and nothing else; selecting one never
//   fetches and never changes what the buttons will fetch.
//
// They used to be a single list, with the button deriving its target from the
// selected chip. That made the primary CTA change under you as you filtered.

// 3m is charted but NOT fetchable, on purpose. A wider window re-finds the
// companies the narrower ones already hold — the search prompt is never told
// what is cached, and dedupe happens at read time in
// getAllDiscoveredStartups — so every extra button is a re-billing of results
// you already have. 7d and 30d are the two worth that cost.
export const FETCHABLE_RANGES: { value: DateRange; label: string }[] = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
];

// Always rendered, even at zero, so the row's shape does not shift as results
// come and go.
export const PINNED_CHIPS: { value: DateRange; label: string }[] = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "3m", label: "3 months" },
];

// Retired windows. A chip appears only while cached data for the window still
// exists — results already paid for stay visible and filterable. Removing
// these from DateRange itself would invalidate discovered_startups rows that
// still carry them.
export const LEGACY_RANGES: { value: DateRange; label: string }[] = [
  { value: "6m", label: "6 months" },
  { value: "6-18m", label: "6–18 mo" },
];

export function labelForRange(range: DateRange): string {
  return (
    [...PINNED_CHIPS, ...LEGACY_RANGES].find((o) => o.value === range)?.label ??
    range
  );
}
