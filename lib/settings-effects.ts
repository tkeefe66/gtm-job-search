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
  // Titles and locations are the two axes of the query grid, so every cached
  // search result was produced by a grid that no longer exists.
  [SETTING_KEYS.titles]: ["role_searches", "discovered_roles"],
  [SETTING_KEYS.locations]: ["role_searches", "discovered_roles"],
  // Stack terms only feed the stack-family role search. discovered_roles is
  // populated by the per-company Find Roles path, which never uses them.
  [SETTING_KEYS.stackTerms]: ["role_searches"],
  [SETTING_KEYS.locationRule]: ["role_searches", "discovered_roles"],
  // The fit brain re-scores roles; it does not change which roles a search
  // returns, so no cached search result is stale because of it. rescoreAll is
  // the remedy offered for this one instead.
  [SETTING_KEYS.fitBrain]: [],
  // The ceiling caps how many queries run. It changes coverage of a FUTURE
  // run, never the correctness of a past one.
  [SETTING_KEYS.searchCeiling]: [],
  // Reserved by the companion compensation plan; nothing reads it yet, and a
  // comp floor filters results rather than changing what is searched for.
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
 * The settings that change WHAT THE CRAWLER LOOKS FOR, and therefore reset its
 * stale-posting closure debounce (see CRITERIA_CHANGED_AT_KEY).
 *
 * Narrower than "any setting changed" on purpose. The fit brain re-scores
 * roles it already found, the ceiling and the comp floor do not touch the
 * crawler at all — stamping on any of them would suppress closure for ~2 crawl
 * cycles per company after a change that cannot have invalidated a single
 * previous crawl result.
 */
export const AFFECTS_CRAWL: SettingKey[] = [
  SETTING_KEYS.titles,
  SETTING_KEYS.locations,
  SETTING_KEYS.locationRule,
];

export function affectsCrawl(key: SettingKey): boolean {
  return AFFECTS_CRAWL.includes(key);
}
