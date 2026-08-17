// Which "how was this role found" values the Source filter offers.
//
// Pure, and separate from components/RolesTable.tsx for the usual reason in this
// repo: the component cannot be reached from a test (vitest here is
// `environment: "node"` with no jsdom), so the rule that decides what the filter
// can offer would otherwise be unpinnable.
//
// NO Tailwind class strings here. tailwind.config.ts scans ./app/** and
// ./components/** only, so an arbitrary-value class written under lib/ is never
// generated and renders unstyled through a green build. The label/colour map
// (PROVENANCE) therefore stays in the component; this file deals only in the
// raw `jobs.source` values.

/**
 * The sources this app writes, in the order the filter should offer them.
 *
 * Deliberately not alphabetical: it runs machine-found first (the overwhelming
 * majority of rows) and human-entered last, so the common case is nearest the
 * top of the menu. These strings are the values `jobs.source` actually holds —
 * see the PROVENANCE map in components/RolesTable.tsx, which renders them.
 */
export const KNOWN_SOURCES = [
  "Crawl",
  "Role Search",
  "Discover",
  "Manual",
  "Recruiter",
] as const;

/**
 * The source values worth offering, given the roles actually loaded.
 *
 * Only sources PRESENT in the data are returned. Offering one that matches
 * nothing gives the user a filter whose only outcome is an empty table, and
 * this list is short enough that the omission is not confusing.
 *
 * An unrecognised value is kept rather than dropped, for the same reason
 * ProvenanceBadge renders it verbatim: a new insert path that forgets to use
 * one of the known strings should be visible in the UI, not silently
 * unfilterable. Known values come first in KNOWN_SOURCES order; anything else
 * follows, sorted, so the tail is stable rather than dependent on row order.
 *
 * `null` is ignored: `jobs.source` is nullable and a row that never got stamped
 * is not a category anyone would filter by.
 */
export function sourceOptions(sources: readonly (string | null)[]): string[] {
  const present = new Set<string>();
  for (const s of sources) {
    if (typeof s === "string" && s.trim()) present.add(s);
  }

  // Array.from rather than spreading the Set: this repo's tsconfig target
  // predates es2015 iteration, so `[...set]` fails the build with
  // --downlevelIteration. Same reason resolveStatuses in lib/job-statuses.ts
  // uses it.
  const known: string[] = KNOWN_SOURCES.filter((s) => present.has(s));
  const unknown = Array.from(present)
    .filter((s) => !(KNOWN_SOURCES as readonly string[]).includes(s))
    .sort();

  return known.concat(unknown);
}
