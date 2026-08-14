// What saving (or resetting) a given setting invalidates.
//
// Pure and separate from app/actions/settings.ts for one reason: server
// actions in this repo are unreachable from a test (they read the database and
// call Claude), and both rules below are decisions that quietly cost money or
// quietly corrupt results when they drift. Here they can be pinned by
// lib/settings-effects.test.ts.

import { SETTING_KEYS, type SettingKey } from "@/lib/settings-store";

/**
 * Which cache tables a change to each setting invalidates.
 *
 * `jobs` is deliberately absent from every entry and must stay that way. It is
 * not a cache — it is the user's pipeline, carrying hand-edited statuses,
 * notes, and recruiter contacts. `role_searches` and `discovered_roles` hold
 * cached API responses, and every role in them was already written to `jobs`
 * by ingestRoles at search time, so clearing them discards nothing the user
 * found.
 *
 * `discovered_startups` is deliberately absent too: funding results barely
 * depend on the criteria (the location rule is only a soft ranking hint there)
 * and they are the most expensive cache to regenerate.
 *
 * Typed `Record<SettingKey, string[]>` rather than `Record<string, string[]>`
 * so adding a setting is a COMPILE error here instead of silently resolving to
 * "clears nothing" through a `?? []` fallback. An empty array is a decision;
 * a missing entry is an oversight, and the two must not look alike.
 */
export const CACHES_TO_CLEAR: Record<SettingKey, string[]> = {
  // Titles reach both caches: they are an axis of the role_searches query grid
  // AND `titleListForPrompt(criteria)` in the per-company Find Roles prompt
  // (app/actions/roles.ts:60), which is the only writer of discovered_roles.
  [SETTING_KEYS.titles]: ["role_searches", "discovered_roles"],
  // Locations are SEARCH-ONLY. `criteria.locations` is consumed by exactly two
  // functions — titleQueries and stackQueries in lib/search-criteria.ts — both
  // of which feed role_searches. The Find Roles prompt that fills
  // discovered_roles reads titleListForPrompt and locationRule and never
  // touches this list, so clearing that cache here would burn an 8000-token,
  // 10+-web-search regeneration per watched company for a change it cannot
  // observe. Same reasoning as stackTerms below. Verified by grep, not by the
  // plan text, which had this wrong.
  [SETTING_KEYS.locations]: ["role_searches"],
  // Stack terms only feed the stack-family role search. discovered_roles is
  // populated by the per-company Find Roles path, which never uses them.
  [SETTING_KEYS.stackTerms]: ["role_searches"],
  // The location rule is pasted verbatim into both prompts — the role search
  // and the per-company Find Roles call — so it invalidates both caches.
  [SETTING_KEYS.locationRule]: ["role_searches", "discovered_roles"],
  // The fit brain re-scores roles; it does not change which roles a search
  // returns, so no cached search result is stale because of it. rescoreAll is
  // the remedy offered for this one instead.
  [SETTING_KEYS.fitBrain]: [],
  // The ceiling caps how many queries run. It changes coverage of a FUTURE
  // run, never the correctness of a past one.
  [SETTING_KEYS.searchCeiling]: [],
  // The comp floor filters results at DISPLAY time rather than changing what
  // is searched for, so no cached search result is stale because of it. It is
  // not effect-free, though — see PATHS_TO_REVALIDATE below.
  [SETTING_KEYS.compFloor]: [],
};

/**
 * The cache tables a save of `key` must clear.
 *
 * Returns a fresh array: callers iterate and could otherwise splice the
 * module-level source of truth for the rest of the process's life.
 */
export function cachesToClear(key: SettingKey): string[] {
  return [...CACHES_TO_CLEAR[key]];
}

/**
 * Which RENDERED ROUTES a change to each setting invalidates.
 *
 * `export const dynamic = "force-dynamic"` on app/roles/page.tsx opts that
 * route out of the full-route cache, but NOT out of Next 14's client-side
 * Router Cache: a soft navigation from /settings to /roles serves the
 * prefetched payload, carrying the OLD floor, for up to `staleTimes.dynamic`
 * (~30s by default). Save a floor, click through, and the filter ignores it —
 * then a manual reload fixes it, which is the shape of bug report that costs
 * an hour to reproduce. `revalidatePath` evicts both caches for the route.
 *
 * Only routes that READ a setting DURING RENDER belong here. /settings itself
 * does not: it re-reads through its own server action after every save, and
 * listing it would make each save do a redundant round trip. Nothing else in
 * the app reads a setting at render time — every other page is a client
 * component that fetches for itself.
 *
 * Typed `Record<SettingKey, string[]>` for the same reason CACHES_TO_CLEAR is:
 * a new setting must be a compile error here, not a silent "revalidates
 * nothing" that shows up as a stale page nobody can reproduce.
 */
export const PATHS_TO_REVALIDATE: Record<SettingKey, string[]> = {
  [SETTING_KEYS.titles]: [],
  [SETTING_KEYS.locations]: [],
  [SETTING_KEYS.stackTerms]: [],
  [SETTING_KEYS.locationRule]: [],
  [SETTING_KEYS.fitBrain]: [],
  [SETTING_KEYS.searchCeiling]: [],
  // /roles reads the floor in its server component and filters the table by
  // it. It is the only route in the app that renders a setting.
  [SETTING_KEYS.compFloor]: ["/roles"],
};

/**
 * The routes a save or reset of `key` must revalidate.
 *
 * Returns a fresh array, like cachesToClear, so a caller cannot splice the
 * module-level source of truth for the life of the process.
 */
export function pathsToRevalidate(key: SettingKey): string[] {
  return [...PATHS_TO_REVALIDATE[key]];
}

/**
 * The settings that change WHAT THE CRAWLER LOOKS FOR, and therefore reset its
 * stale-posting closure debounce (see CRITERIA_CHANGED_AT_KEY).
 *
 * Exactly the two values the crawl path reads. `lib/crawler.ts:76`
 * (buildExtractionPrompt) and `lib/crawler.ts:299` (the web-search fallback
 * tier) interpolate `titleListForPrompt(criteria)` and `criteria.locationRule`
 * — and nothing else off the criteria object.
 *
 * Everything else is excluded on evidence, not on caution:
 *   - `locations` is search-only. It is read by titleQueries and stackQueries
 *     alone; no crawl prompt contains it. The plan text listed it here, which
 *     was wrong.
 *   - `stackTerms` never reach a crawl prompt either.
 *   - `fitBrain` re-scores roles the crawler already found.
 *   - `searchCeiling` and `compFloor` do not touch the crawler at all.
 *
 * Stamping on any of those suppresses stale-posting closure for ~2 crawl
 * cycles per company after a change the crawler cannot observe.
 */
export const AFFECTS_CRAWL: SettingKey[] = [
  SETTING_KEYS.titles,
  SETTING_KEYS.locationRule,
];

export function affectsCrawl(key: SettingKey): boolean {
  return AFFECTS_CRAWL.includes(key);
}
