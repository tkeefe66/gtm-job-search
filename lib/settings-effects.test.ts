import { describe, expect, test } from "vitest";
import {
  AFFECTS_CRAWL,
  CACHES_TO_CLEAR,
  PATHS_TO_REVALIDATE,
  affectsCrawl,
  cachesToClear,
  pathsToRevalidate,
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

  test("the two settings the Find Roles prompt reads drop both role caches", () => {
    // app/actions/roles.ts:60 — the ONLY writer of discovered_roles —
    // interpolates titleListForPrompt(criteria) and criteria.locationRule.
    // Those are exactly the two settings that can invalidate that cache.
    expect(cachesToClear(SETTING_KEYS.titles)).toEqual([
      "role_searches",
      "discovered_roles",
    ]);
    expect(cachesToClear(SETTING_KEYS.locationRule)).toEqual([
      "role_searches",
      "discovered_roles",
    ]);
  });

  test("locations are SEARCH-ONLY and must not drop discovered_roles", () => {
    // criteria.locations is consumed by exactly two functions — titleQueries
    // and stackQueries in lib/search-criteria.ts — and both feed role_searches
    // alone. No crawl or Find Roles prompt contains the location list; they
    // read titleListForPrompt and locationRule (lib/crawler.ts:76, :299,
    // app/actions/roles.ts:60). Clearing discovered_roles here would burn an
    // 8000-token, 10+-web-search regeneration per watched company for a change
    // that provably cannot have affected it.
    //
    // The plan text said otherwise. This was settled by grepping every reader
    // of `.locations`, not by reading the plan — do not "correct" it back.
    expect(cachesToClear(SETTING_KEYS.locations)).toEqual(["role_searches"]);
  });

  test("stack terms drop only the stack-family cache", () => {
    // Same reasoning as locations: discovered_roles is filled by the
    // per-company Find Roles path, which never uses stack terms.
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
  test("exactly the two values a crawl prompt interpolates", () => {
    // lib/crawler.ts:76 (buildExtractionPrompt) and lib/crawler.ts:299 (the
    // web-search fallback tier) read titleListForPrompt(criteria) and
    // criteria.locationRule off the criteria object. Nothing else.
    expect(affectsCrawl(SETTING_KEYS.titles)).toBe(true);
    expect(affectsCrawl(SETTING_KEYS.locationRule)).toBe(true);
  });

  test("locations and stack terms are search-only, so they never stamp", () => {
    // Both are read exclusively by titleQueries / stackQueries, which build
    // web-search query strings. No crawl prompt contains either list, so a
    // stamp on them would suppress stale-posting closure for ~2 crawl cycles
    // per company over a change the crawler cannot observe.
    //
    // The plan text listed `locations` here. Verified wrong by grep.
    expect(affectsCrawl(SETTING_KEYS.locations)).toBe(false);
    expect(affectsCrawl(SETTING_KEYS.stackTerms)).toBe(false);
  });

  test("the fit brain, the ceiling, and the comp floor do not either", () => {
    // The brain re-scores roles the crawler already found; the other two never
    // reach the crawler at all.
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

describe("PATHS_TO_REVALIDATE", () => {
  test("covers every setting key, so no save falls through to 'revalidates nothing'", () => {
    expect(ALL_KEYS.length).toBeGreaterThan(0);
    expect(Object.keys(PATHS_TO_REVALIDATE).sort()).toEqual([...ALL_KEYS].sort());
  });

  test("the comp floor revalidates /roles", () => {
    // /roles is a force-dynamic server component that READS the floor. Without
    // this, Next 14's client Router Cache keeps serving a prefetched /roles
    // carrying the old floor for ~30s after a save — the filter appears to
    // ignore the setting until a manual reload.
    expect(pathsToRevalidate(SETTING_KEYS.compFloor)).toEqual(["/roles"]);
  });

  test("nothing else revalidates anything — no setting but the floor is rendered", () => {
    // Every other page is a client component that fetches for itself, so a
    // revalidate would be a wasted round trip on every save.
    const others = ALL_KEYS.filter((k) => k !== SETTING_KEYS.compFloor);
    expect(others.length).toBe(ALL_KEYS.length - 1);
    expect(others.length).toBeGreaterThan(0);
    for (const key of others) {
      expect(pathsToRevalidate(key)).toEqual([]);
    }
  });

  test("never revalidates /settings — it re-reads through its own action", () => {
    const allPaths = ALL_KEYS.flatMap((k) => PATHS_TO_REVALIDATE[k]);
    expect(allPaths.length).toBeGreaterThan(0);
    expect(allPaths).not.toContain("/settings");
  });

  test("hands out a fresh array, so a caller cannot splice the source of truth", () => {
    const first = pathsToRevalidate(SETTING_KEYS.compFloor);
    first.push("/watchlist");
    expect(pathsToRevalidate(SETTING_KEYS.compFloor)).toEqual(["/roles"]);
  });

  test("every path is an absolute route, not a page-file path", () => {
    // revalidatePath("app/roles/page.tsx") silently matches nothing.
    const allPaths = ALL_KEYS.flatMap((k) => PATHS_TO_REVALIDATE[k]);
    expect(allPaths.length).toBeGreaterThan(0);
    for (const p of allPaths) {
      expect(p.startsWith("/")).toBe(true);
      expect(p).not.toMatch(/\.tsx?$/);
    }
  });
});
