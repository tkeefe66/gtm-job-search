import { describe, expect, test } from "vitest";
import {
  AFFECTS_CRAWL,
  CACHES_TO_CLEAR,
  affectsCrawl,
  cachesToClear,
} from "./settings-effects";
import { CRITERIA_CHANGED_AT_KEY, SETTING_KEYS, type SettingKey } from "./settings-store";

const ALL_KEYS = Object.values(SETTING_KEYS) as SettingKey[];

describe("CACHES_TO_CLEAR", () => {
  test("covers every setting key, so no save falls through to 'clears nothing'", () => {
    expect(ALL_KEYS.length).toBeGreaterThan(0);
    expect(Object.keys(CACHES_TO_CLEAR).sort()).toEqual([...ALL_KEYS].sort());
  });

  test("never clears `jobs` — that is the user's pipeline, not a cache", () => {
    // jobs carries hand-edited statuses, notes, and recruiter contacts. There
    // is no history table and no undo. The length assertion is the guard
    // against vacuity: [].every(...) is true, so an all-empty map would pass
    // the .every below while proving nothing.
    const allTables = ALL_KEYS.flatMap((k) => CACHES_TO_CLEAR[k]);
    expect(allTables.length).toBeGreaterThan(0);
    expect(allTables.every((t) => t !== "jobs")).toBe(true);
  });

  test("never clears `discovered_startups` — the most expensive cache to rebuild", () => {
    // Funding results barely depend on the criteria; the location rule is only
    // a soft ranking hint there.
    const allTables = ALL_KEYS.flatMap((k) => CACHES_TO_CLEAR[k]);
    expect(allTables.length).toBeGreaterThan(0);
    expect(allTables).not.toContain("discovered_startups");
  });

  test("editing a query axis drops both role caches", () => {
    expect(cachesToClear(SETTING_KEYS.titles)).toEqual([
      "role_searches",
      "discovered_roles",
    ]);
    expect(cachesToClear(SETTING_KEYS.locations)).toEqual([
      "role_searches",
      "discovered_roles",
    ]);
    expect(cachesToClear(SETTING_KEYS.locationRule)).toEqual([
      "role_searches",
      "discovered_roles",
    ]);
  });

  test("stack terms drop only the stack-family cache", () => {
    // discovered_roles is filled by the per-company Find Roles path, which
    // never uses stack terms — dropping it would burn a Claude call per
    // watched company for a change that cannot have affected them.
    expect(cachesToClear(SETTING_KEYS.stackTerms)).toEqual(["role_searches"]);
  });

  test("the fit brain and the ceiling invalidate nothing", () => {
    // Neither changes which roles a search RETURNS: the brain re-scores what
    // was already found (rescoreAll is the remedy offered instead), and the
    // ceiling caps a future run rather than invalidating a past one.
    expect(cachesToClear(SETTING_KEYS.fitBrain)).toEqual([]);
    expect(cachesToClear(SETTING_KEYS.searchCeiling)).toEqual([]);
    expect(cachesToClear(SETTING_KEYS.compFloor)).toEqual([]);
  });

  test("hands back a copy, not the module's own array", () => {
    // The caller iterates this list; returning the live array lets a future
    // caller splice the source of truth for the rest of the process. toBe,
    // not toEqual — identical content is exactly what toEqual cannot separate
    // from identical identity here.
    const first = cachesToClear(SETTING_KEYS.titles);
    expect(first).not.toBe(CACHES_TO_CLEAR[SETTING_KEYS.titles]);
    first.push("jobs");
    expect(CACHES_TO_CLEAR[SETTING_KEYS.titles]).not.toContain("jobs");
  });
});

describe("AFFECTS_CRAWL", () => {
  test("the three settings that change what the crawler looks for", () => {
    expect(affectsCrawl(SETTING_KEYS.titles)).toBe(true);
    expect(affectsCrawl(SETTING_KEYS.locations)).toBe(true);
    expect(affectsCrawl(SETTING_KEYS.locationRule)).toBe(true);
  });

  test("the fit brain, the ceiling, and the comp floor do not", () => {
    // Stamping on these would reset the crawler's closure debounce and
    // suppress stale-posting closure for ~2 crawl cycles per company after a
    // change that cannot have invalidated a single previous crawl result.
    expect(affectsCrawl(SETTING_KEYS.fitBrain)).toBe(false);
    expect(affectsCrawl(SETTING_KEYS.searchCeiling)).toBe(false);
    expect(affectsCrawl(SETTING_KEYS.compFloor)).toBe(false);
  });

  test("is a strict subset of the real settings — never the stamp key itself", () => {
    expect(AFFECTS_CRAWL.length).toBeGreaterThan(0);
    expect(AFFECTS_CRAWL.length).toBeLessThan(ALL_KEYS.length);
    for (const key of AFFECTS_CRAWL) expect(ALL_KEYS).toContain(key);
    expect(AFFECTS_CRAWL).not.toContain(CRITERIA_CHANGED_AT_KEY);
  });

  test("anything that changes the crawl also invalidates at least one cache", () => {
    // The converse is allowed (stackTerms clears a cache without touching the
    // crawler), but a setting that changes what the crawler looks for while
    // leaving cached search results in place would serve results from a query
    // grid that no longer exists.
    expect(AFFECTS_CRAWL.length).toBeGreaterThan(0);
    for (const key of AFFECTS_CRAWL) {
      expect(cachesToClear(key).length).toBeGreaterThan(0);
    }
  });
});
