# Editable Search Criteria Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make target titles, search locations, GTM stack terms, the location rule, and the fit-scoring brain editable from a `/settings` page instead of requiring a code edit and redeploy.

**Architecture:** Today's constants become `DEFAULT_*` exports serving as both the seed for a fresh install and the runtime fallback. The pure query functions stop reading module state and take a criteria object as a parameter, so they stay testable without a database. One async `loadCriteria()` reads a new `app_settings` table and merges over the defaults. Four call sites change.

**Tech Stack:** Next.js 14 App Router, TypeScript, Tailwind, Railway Postgres via `lib/supabase.ts`, Anthropic SDK, vitest.

**Spec:** `docs/superpowers/specs/2026-08-13-search-settings-design.md`

**Companion plan:** `docs/superpowers/plans/2026-08-13-compensation-floor.md` implements the spec's compensation half. It depends on this plan's Task 1 and Task 7. Build this one first.

## Global Constraints

- **The pre-deploy gate is `npm run build && npm test`.** `npm run lint` has never worked in this repo — no ESLint config, `next lint` blocks on an interactive prompt, and adding a config makes `next build` fail on 3 pre-existing errors. Never add it to any gate.
- **No API routes.** The only one is the pre-existing cron route. User-facing backend entry points are React Server Actions in `app/actions/`; shared machinery lives in `lib/`.
- **`lib/supabase.ts` is NOT Supabase** — a hand-rolled Supabase-shaped builder over `pg`. Its filter surface is only `.eq()` / `.neq()`; it supports `.from .select .insert .update .upsert(obj, {onConflict}) .delete .order .limit .single .maybeSingle`. Anything else requires `rawQuery()`.
- **Schema truth is `db/schema.sql`**, applied with `DATABASE_URL=<public proxy URL> node db/apply-schema.mjs`, and must stay idempotent.
- **No ATS vendor APIs and no job aggregator APIs.** Discovery happens only through Claude's `web_search` server tool.
- **Explicit over silent.** Error messages say what failed, why, and what to try. A settings read failure must fall back to defaults and log loudly — never throw, because the crawler depends on it.
- **Pure logic lives in `lib/*.ts` with a sibling `lib/*.test.ts`** (vitest). Server actions in `app/actions/` and React components are not unit-tested in this repo.
- **Every test must fail against a broken implementation.** `[].every(...)` is `true`, so pair any `.every` assertion with a non-empty length assertion. Construct any U+00A0 with an explicit `"\xa0"` escape and byte-verify the file afterward — a literal one has slipped into this repo before.
- **Baseline is 136 passing tests across 14 files.** Every task must leave them passing except where this plan explicitly rewrites them.

---

### Task 1: The `app_settings` table and the settings store

**Files:**
- Modify: `db/schema.sql` (append `app_settings`)
- Create: `lib/settings-store.ts`
- Create: `lib/settings-store.test.ts`

**Interfaces:**
- Produces: `SETTING_KEYS` (const object, values equal to `Criteria` field names), `type SettingKey`, `mergeSettings(defaults, rows)` (with a shape guard), `readNumberSetting(key)`, `readCeiling()`, and async `readAllSettings()` / `writeSetting(key, value)` / `deleteSetting(key)`.
- Typed scalar readers built on `readNumberSetting` are the intended extension point — the companion plan adds `readCompFloor` the same way.
- Consumed by: Task 2 (`loadCriteria`), Task 6 (server actions), and the companion compensation plan.

- [ ] **Step 1: Append the table to `db/schema.sql`**

```sql
-- User-editable search criteria and scoring inputs. One row per setting;
-- a missing row means "use the shipped default" (see lib/search-criteria.ts),
-- which is also what makes "reset to defaults" a plain DELETE.
create table if not exists app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz default now()
);
```

- [ ] **Step 2: Write the failing test for `mergeSettings`**

Create `lib/settings-store.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { mergeSettings } from "./settings-store";

describe("mergeSettings", () => {
  test("returns defaults when no rows are stored", () => {
    const defaults = { titles: ["A", "B"], rule: "r" };
    expect(mergeSettings(defaults, [])).toEqual(defaults);
  });

  test("a stored row overrides its default", () => {
    const defaults = { titles: ["A"], rule: "r" };
    const merged = mergeSettings(defaults, [{ key: "titles", value: ["X", "Y"] }]);
    expect(merged.titles).toEqual(["X", "Y"]);
    expect(merged.rule).toBe("r");
  });

  test("a row with an unknown key is ignored, not merged in", () => {
    const defaults = { titles: ["A"] };
    const merged = mergeSettings(defaults, [{ key: "bogus", value: 1 }]);
    expect(merged).toEqual({ titles: ["A"] });
    expect("bogus" in merged).toBe(false);
  });

  test("a stored null does not blank out a default", () => {
    const defaults = { titles: ["A"] };
    expect(mergeSettings(defaults, [{ key: "titles", value: null }]).titles).toEqual(["A"]);
  });

  test("does not mutate the defaults object", () => {
    const defaults = { titles: ["A"] };
    mergeSettings(defaults, [{ key: "titles", value: ["X"] }]);
    expect(defaults.titles).toEqual(["A"]);
  });

  test("ignores a value of the wrong shape rather than poisoning the crawler", () => {
    // A string here would make titleListForPrompt call .join on a string and
    // throw mid-crawl. Must fall back to the default, not merge.
    const defaults = { titles: ["A"], rule: "r" };
    expect(mergeSettings(defaults, [{ key: "titles", value: "oops" }]).titles).toEqual(["A"]);
    expect(mergeSettings(defaults, [{ key: "rule", value: ["oops"] }]).rule).toBe("r");
  });
});

describe("SETTING_KEYS alignment", () => {
  test("every Criteria field has a matching SETTING_KEYS value", () => {
    // One-directional on purpose: searchCeiling and compFloor are settings but
    // NOT Criteria fields, so a bijection assertion would fail. Drift in the
    // other direction makes every save a silent no-op.
    const fields = Object.keys(DEFAULT_CRITERIA);
    expect(fields.length).toBeGreaterThan(0);
    for (const f of fields) expect(Object.values(SETTING_KEYS)).toContain(f);
  });
});
```

- [ ] **Step 3: Run the test and watch it fail**

Run: `npm test -- settings-store`
Expected: FAIL — `mergeSettings is not a function`.

- [ ] **Step 4: Implement `lib/settings-store.ts`**

```ts
import { rawQuery } from "@/lib/supabase";

// The full set of editable settings. Adding one here plus a default in
// lib/search-criteria.ts is the whole change — app_settings is key/value, so
// there is no migration.
// Values MUST equal the `Criteria` field names in lib/search-criteria.ts —
// mergeSettings skips unknown keys BY DESIGN, so a drifted spelling makes
// every save a silent no-op with no error anywhere. Pinned by a test.
export const SETTING_KEYS = {
  titles: "titles",
  locations: "locations",
  stackTerms: "stackTerms",
  locationRule: "locationRule",
  fitBrain: "fitBrain",
  searchCeiling: "searchCeiling",
  compFloor: "compFloor",
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

export interface SettingRow {
  key: string;
  value: unknown;
}

/**
 * Overlays stored rows onto the shipped defaults.
 *
 * A row whose key is not already present in `defaults` is ignored rather than
 * merged: an unknown key is either a leftover from a removed setting or a
 * typo, and letting it through would put a field on the criteria object that
 * nothing reads and no default documents. A stored null is treated the same
 * way as a missing row, so a bad write degrades to the default instead of
 * blanking a list the crawler depends on.
 */
export function mergeSettings<T extends Record<string, unknown>>(
  defaults: T,
  rows: SettingRow[]
): T {
  const merged = { ...defaults };
  for (const row of rows) {
    if (!(row.key in defaults)) continue;
    if (row.value === null || row.value === undefined) continue;
    // Shape guard. Without it a row like {key:"titles", value:"a string"}
    // passes every check above and lands on criteria.titles, and
    // titleListForPrompt then calls .join on a string and throws mid-crawl.
    const before = defaults[row.key];
    if (Array.isArray(before) !== Array.isArray(row.value)) {
      console.error(
        `settings-store: ignoring "${row.key}" — stored value is the wrong shape.`
      );
      continue;
    }
    if (!Array.isArray(before) && typeof before !== typeof row.value) {
      console.error(
        `settings-store: ignoring "${row.key}" — expected ${typeof before}.`
      );
      continue;
    }
    (merged as Record<string, unknown>)[row.key] = row.value;
  }
  return merged;
}

/** Reads one scalar setting. A missing row, or a row holding a non-number
 *  (a bad write, a hand-edit), reads as null — the same as "not set". */
export async function readNumberSetting(key: SettingKey): Promise<number | null> {
  const rows = await readAllSettings();
  const row = rows.find((r) => r.key === key);
  return typeof row?.value === "number" ? row.value : null;
}

export const readCeiling = () => readNumberSetting(SETTING_KEYS.searchCeiling);

export async function readAllSettings(): Promise<SettingRow[]> {
  const { data, error } = await rawQuery<{ key: string; value: unknown }>(
    `select key, value from app_settings`
  );
  if (error) {
    // Deliberately not thrown: the crawler calls this on every run, and an
    // empty title list would make it silently report "no roles" for every
    // tracked company. Falling back to shipped defaults keeps last-known-good
    // behavior. Loud in the log, invisible in behavior.
    console.error(
      `settings-store: could not read app_settings — ${error.message}. ` +
        `Falling back to shipped defaults.`
    );
    return [];
  }
  return data ?? [];
}

export async function writeSetting(
  key: SettingKey,
  value: unknown
): Promise<{ error?: string }> {
  const { error } = await rawQuery(
    `insert into app_settings (key, value, updated_at)
     values ($1, $2::jsonb, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, JSON.stringify(value)]
  );
  return { error: error?.message };
}

export async function deleteSetting(key: SettingKey): Promise<{ error?: string }> {
  const { error } = await rawQuery(`delete from app_settings where key = $1`, [key]);
  return { error: error?.message };
}
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `npm test -- settings-store`
Expected: PASS, 5 tests.

- [ ] **Step 6: Verify the build**

Run: `npm run build && npm test`
Expected: clean, 141 tests.

- [ ] **Step 7: Note the schema application as pending**

Do NOT apply the schema — there are no database credentials in this worktree. Record in your report: `SKIPPED — schema application requires DATABASE_URL`. The user applies it during the live pass.

- [ ] **Step 8: Commit**

```bash
git add db/schema.sql lib/settings-store.ts lib/settings-store.test.ts
git commit -m "feat: add app_settings table and settings store"
```

---

### Task 2: Invert the dependency — criteria as a parameter

**Files:**
- Modify: `lib/search-criteria.ts`
- Modify: `lib/search-criteria.test.ts` (rewrite all 18 tests)

**Interfaces:**
- Consumes: `mergeSettings`, `readAllSettings`, `SETTING_KEYS` (Task 1).
- Produces: `type Criteria`, `DEFAULT_CRITERIA`, `loadCriteria()`, and the reshaped `titleQueries(criteria)`, `stackQueries(criteria)`, `titleListForPrompt(criteria)`.

This is the architectural core. Read `lib/search-criteria.ts` in full before starting.

- [ ] **Step 1: Rewrite the tests to pass criteria explicitly**

The existing 18 tests assert against module constants. They must now build their own criteria objects — that is what keeps them pure and database-free. Replace the whole file:

```ts
import { describe, expect, test } from "vitest";
import {
  DEFAULT_CRITERIA,
  MAX_QUERY_MULTIPLIER,
  pickQueries,
  roleExtractionSchema,
  stackQueries,
  titleListForPrompt,
  titleQueries,
  type Criteria,
} from "./search-criteria";

const SMALL: Criteria = {
  titles: ["Head of RevOps", "GTM Engineer"],
  locations: ["Denver", "remote"],
  stackTerms: ["Clay", "Gong"],
  locationRule: "Remote or Colorado only.",
  fitBrain: "A candidate.",
};

describe("DEFAULT_CRITERIA", () => {
  test("target titles cover the core GTM systems roles", () => {
    const joined = DEFAULT_CRITERIA.titles.join(" | ").toLowerCase();
    expect(joined).toContain("revenue operations");
    expect(joined).toContain("gtm systems");
    expect(joined).toContain("gtm engineer");
    expect(joined).toContain("marketing operations");
  });

  test("stack terms include the GTM tools that identify these roles", () => {
    const joined = DEFAULT_CRITERIA.stackTerms.join(" ").toLowerCase();
    expect(joined).toContain("salesforce");
    expect(joined).toContain("clay");
    expect(joined).toContain("gong");
  });

  test("location rule names both the remote and Colorado conditions", () => {
    expect(DEFAULT_CRITERIA.locationRule.toLowerCase()).toContain("remote");
    expect(DEFAULT_CRITERIA.locationRule).toContain("Denver");
    expect(DEFAULT_CRITERIA.locationRule).toContain("Boulder");
  });

  test("every default list is non-empty", () => {
    expect(DEFAULT_CRITERIA.titles.length).toBeGreaterThan(0);
    expect(DEFAULT_CRITERIA.locations.length).toBeGreaterThan(0);
    expect(DEFAULT_CRITERIA.stackTerms.length).toBeGreaterThan(0);
  });

  test("fit brain describes the candidate and names a location preference", () => {
    expect(DEFAULT_CRITERIA.fitBrain.length).toBeGreaterThan(200);
    expect(DEFAULT_CRITERIA.fitBrain).toContain("Denver");
  });
});

describe("titleListForPrompt", () => {
  test("renders the supplied criteria, not the defaults", () => {
    const rendered = titleListForPrompt(SMALL);
    expect(rendered).toBe("Head of RevOps, GTM Engineer");
    expect(rendered).not.toContain("Marketing Operations");
  });

  test("has no trailing or doubled comma", () => {
    const rendered = titleListForPrompt(SMALL);
    expect(rendered.endsWith(",")).toBe(false);
    expect(rendered).not.toContain(",,");
  });
});

describe("titleQueries", () => {
  test("produces one query per title and location from the supplied criteria", () => {
    const queries = titleQueries(SMALL);
    expect(queries.length).toBe(4);
  });

  test("quotes the title so search engines match the phrase", () => {
    expect(titleQueries(SMALL)).toContain('"Head of RevOps" Denver job opening');
  });

  test("every query carries a location term", () => {
    const queries = titleQueries(SMALL);
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) {
      expect(SMALL.locations.some((t) => q.includes(t))).toBe(true);
    }
  });

  test("returns nothing when either list is empty rather than emitting a malformed query", () => {
    expect(titleQueries({ ...SMALL, titles: [] })).toEqual([]);
    expect(titleQueries({ ...SMALL, locations: [] })).toEqual([]);
  });
});

describe("stackQueries", () => {
  test("pairs tool names with hiring language", () => {
    const queries = stackQueries(SMALL);
    expect(queries.length).toBe(4);
    expect(queries.some((q) => q.includes("Clay"))).toBe(true);
    expect(queries.every((q) => q.toLowerCase().includes("hiring"))).toBe(true);
  });

  test("every query carries a location term", () => {
    const queries = stackQueries(SMALL);
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) {
      expect(SMALL.locations.some((t) => q.includes(t))).toBe(true);
    }
  });

  test("returns nothing when either list is empty", () => {
    expect(stackQueries({ ...SMALL, stackTerms: [] })).toEqual([]);
    expect(stackQueries({ ...SMALL, locations: [] })).toEqual([]);
  });
});

describe("pickQueries", () => {
  const list = Array.from({ length: 39 }, (_, i) => `q${i}`);

  test("returns the input unchanged when it is already within the cap", () => {
    expect(pickQueries(list.slice(0, 5), 10)).toEqual(list.slice(0, 5));
  });

  test("returns exactly the cap when the input exceeds it", () => {
    expect(pickQueries(list, 15).length).toBe(15);
  });

  test("returns no duplicates", () => {
    const picked = pickQueries(list, 15);
    expect(new Set(picked).size).toBe(picked.length);
  });

  test("every returned item comes from the input", () => {
    const picked = pickQueries(list, 15);
    expect(picked.length).toBeGreaterThan(0);
    for (const q of picked) expect(list).toContain(q);
  });

  test("spreads across the whole list rather than taking a head slice", () => {
    const picked = pickQueries(list, 15);
    expect(picked).toContain("q0");
    expect(picked.some((q) => list.indexOf(q) > 30)).toBe(true);
    expect(picked).not.toEqual(list.slice(0, 15));
  });

  test("covers every title at the default cap", () => {
    const queries = titleQueries(DEFAULT_CRITERIA);
    const picked = pickQueries(queries, 15);
    for (const title of DEFAULT_CRITERIA.titles) {
      expect(picked.some((q) => q.includes(`"${title}"`))).toBe(true);
    }
  });

  test("a cap of zero or less yields nothing", () => {
    expect(pickQueries(list, 0)).toEqual([]);
    expect(pickQueries(list, -1)).toEqual([]);
  });
});

describe("MAX_QUERY_MULTIPLIER", () => {
  test("is pinned so changing the runaway rail is deliberate", () => {
    expect(MAX_QUERY_MULTIPLIER).toBe(2);
  });
});

describe("roleExtractionSchema", () => {
  test("names every field the Role type requires", () => {
    const schema = roleExtractionSchema();
    for (const field of [
      "role_title",
      "job_url",
      "location",
      "seniority",
      "salary_range",
      "description_summary",
      "fit_signal",
      "ic_flag",
    ]) {
      expect(schema).toContain(field);
    }
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npm test -- search-criteria`
Expected: FAIL — `DEFAULT_CRITERIA` is not exported and the functions take no arguments.

- [ ] **Step 3: Reshape `lib/search-criteria.ts`**

Keep the existing constant *values* exactly as they are — only the names and the function signatures change. Rename `TARGET_TITLES` → `DEFAULT_TARGET_TITLES`, `GTM_STACK_TERMS` → `DEFAULT_GTM_STACK_TERMS`, `LOCATION_RULE` → `DEFAULT_LOCATION_RULE`, `LOCATION_TERMS` → `DEFAULT_LOCATION_TERMS`. Move `CANDIDATE_BACKGROUND` here from `app/actions/parse-role.ts` as `DEFAULT_FIT_BRAIN`, copying the string byte-for-byte. Leave `ROLE_SEARCH_SYSTEM` and `roleExtractionSchema()` alone — neither is user-editable.

Then add:

```ts
export interface Criteria {
  titles: string[];
  locations: string[];
  stackTerms: string[];
  locationRule: string;
  fitBrain: string;
}

export const DEFAULT_CRITERIA: Criteria = {
  titles: DEFAULT_TARGET_TITLES,
  locations: DEFAULT_LOCATION_TERMS,
  stackTerms: DEFAULT_GTM_STACK_TERMS,
  locationRule: DEFAULT_LOCATION_RULE,
  fitBrain: DEFAULT_FIT_BRAIN,
};

export function titleListForPrompt(criteria: Criteria): string {
  return criteria.titles.join(", ");
}

export function titleQueries(criteria: Criteria): string[] {
  const queries: string[] = [];
  for (const title of criteria.titles) {
    for (const place of criteria.locations) {
      queries.push(`"${title}" ${place} job opening`);
    }
  }
  return queries;
}

export function stackQueries(criteria: Criteria): string[] {
  const queries: string[] = [];
  for (const tool of criteria.stackTerms) {
    for (const place of criteria.locations) {
      queries.push(`"${tool}" revenue operations hiring ${place}`);
    }
  }
  return queries;
}

// The runaway rail, not a coverage ration. Measured cost of an uncapped title
// run is ~$1.13 against ~$0.55 capped — the old fixed cap of 15 rationed
// coverage on the most central titles to save about sixty cents, which is the
// wrong trade for a job search. When the user sets no ceiling, max_uses is
// this multiple of the query count: high enough never to bind in normal use,
// low enough to stop a loop. When the user does set a ceiling, that wins.
export const MAX_QUERY_MULTIPLIER = 2;
```

Keep `pickQueries` exactly as it is, but drop its default-argument reference to the deleted `MAX_QUERIES_PER_SEARCH` — the cap is now always passed explicitly:

```ts
export function pickQueries(queries: string[], cap: number): string[] {
```

Add `loadCriteria()` at the end:

```ts
import { mergeSettings, readAllSettings } from "@/lib/settings-store";

/**
 * The criteria the app is actually running on: shipped defaults with any
 * user-saved overrides on top. Never throws — a failed read logs and returns
 * the defaults (see readAllSettings), because the crawler calls this on every
 * run and an empty title list would make it silently find nothing.
 */
export async function loadCriteria(): Promise<Criteria> {
  const rows = await readAllSettings();
  return mergeSettings(DEFAULT_CRITERIA, rows);
}
```

`SETTING_KEYS` already ships the correct camelCase values from Task 1 and is pinned by the alignment test there. Nothing to rename here.

**This task intentionally leaves `npm run build` red.** It deletes constants that four files still import, and Task 3 is what repairs them. Verify with `npm test -- search-criteria` only; do not run the full gate until Task 3. This is the one place in this plan where the baseline-passing rule is suspended, and it is deliberate.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npm test -- search-criteria`
Expected: PASS.

- [ ] **Step 5: Byte-verify the moved fit brain**

The `CANDIDATE_BACKGROUND` string moved files. Confirm it is byte-identical:

```bash
git show HEAD:app/actions/parse-role.ts | sed -n '/^const CANDIDATE_BACKGROUND/,/^`.trim/p' > /tmp/before.txt
sed -n '/^export const DEFAULT_FIT_BRAIN/,/^`.trim/p' lib/search-criteria.ts > /tmp/after.txt
diff <(tail -n +2 /tmp/before.txt) <(tail -n +2 /tmp/after.txt) && echo "IDENTICAL"
```

Expected: `IDENTICAL`. Report the result.

- [ ] **Step 6: Commit**

```bash
git add lib/search-criteria.ts lib/search-criteria.test.ts lib/settings-store.ts lib/settings-store.test.ts
git commit -m "refactor: criteria become a parameter, constants become defaults"
```

---

### Task 3: Update the four consumers

**Files:**
- Modify: `app/actions/discover.ts`
- Modify: `app/actions/roles.ts`
- Modify: `app/actions/role-search.ts`
- Modify: `lib/crawler.ts`
- Modify: `app/actions/parse-role.ts`
- Modify: `lib/ingest-roles.ts`
- Modify: `components/RolesTable.tsx` (one call site)
- Modify: `components/RecruiterPanel.tsx` (one call site)
- Modify: `app/api/cron/crawl/route.ts` (batch load)
- Modify: `app/actions/watchlist.ts` (two `crawlCompany` callers)
- Modify: `lib/crawler.test.ts` (four `buildExtractionPrompt` tests)
- Create: `lib/fit-inputs.ts`

**Interfaces:**
- Consumes: `loadCriteria`, `Criteria`, `titleQueries`, `stackQueries`, `titleListForPrompt`, `MAX_QUERY_MULTIPLIER`, `pickQueries`, `readCeiling` (Tasks 1-2).
- Produces: `FitInputs`, `loadScoringInputs()`, `RunContext`, and the reshaped `scoreFit` / `buildExtractionPrompt` / `crawlCompany` signatures.

**Verified caller map — the plan originally got this wrong. Do not trust memory; these are the real call sites:**

| Function | Callers |
|---|---|
| `scoreFit` | `lib/ingest-roles.ts:141`, `components/RolesTable.tsx:514`, `components/RecruiterPanel.tsx:74` |
| `crawlCompany` | `app/api/cron/crawl/route.ts:79`, `app/actions/watchlist.ts:226`, `app/actions/watchlist.ts:285` |
| `buildExtractionPrompt` | `lib/crawler.ts` internal + 4 tests at `lib/crawler.test.ts:33-55` |

The two `scoreFit` callers in `components/` are `"use client"` and **cannot** call `loadCriteria()` — it transitively imports `pg`.

- [ ] **Step 1: `app/actions/discover.ts`**

Replace `import { LOCATION_RULE } from "@/lib/search-criteria";` with an import of `loadCriteria`. Inside `discoverStartups`, call `const criteria = await loadCriteria();` before building the prompt and use `criteria.locationRule` where `LOCATION_RULE` appeared.

- [ ] **Step 2: `app/actions/roles.ts`**

Same shape: `await loadCriteria()` inside `findAndSaveRoles`, then `titleListForPrompt(criteria)` and `criteria.locationRule` in the prompt.

- [ ] **Step 3: `app/actions/role-search.ts`**

`await loadCriteria()` inside `findRolesByCriteria`. Replace `allQueriesFor(family)` so it takes criteria: title family → `titleQueries(criteria)`, stack family → `stackQueries(criteria)`. Then apply the ceiling:

```ts
const allQueries = allQueriesFor(family, criteria);
const ceiling = await readCeiling(); // number | null, from Task 6
const queries = ceiling ? pickQueries(allQueries, ceiling) : allQueries;
const maxSearches = ceiling ?? allQueries.length * MAX_QUERY_MULTIPLIER;
```

Pass `maxSearches` to `callWithWebSearch`'s `maxSearches` option (it already exists). Keep the existing `console.log` of the sent list, adjusting the wording so it reports the ceiling state honestly — e.g. `sending 39 of 39 queries (no ceiling set, max_uses 78)`.

- [ ] **Step 4: `lib/crawler.ts` — signatures, not just call sites**

`buildExtractionPrompt` at `lib/crawler.ts:34` is a **synchronous exported** function pinned by four tests at `lib/crawler.test.ts:33-55`, one of which asserts `toContain("Denver")` — which comes from `LOCATION_RULE`. Its new signature:

```ts
export function buildExtractionPrompt(company: string, page: ExtractedPage, criteria: Criteria): string
```

Update all four tests to pass `DEFAULT_CRITERIA`.

There is **no batch function inside `lib/crawler.ts`** — the loop lives in `app/api/cron/crawl/route.ts:79`. So "load once per batch" requires changing `crawlCompany`:

```ts
export interface RunContext {
  criteria: Criteria;
  fitInputs: FitInputs;
  criteriaChangedAt: string | null;   // Task 7 uses this
}

export async function crawlCompany(
  company: string,
  opts: { dryRun?: boolean; ctx?: RunContext } = {}
)
```

`const ctx = opts.ctx ?? (await loadRunContext());` inside, for the two single-company callers (`app/actions/watchlist.ts:226` and `:285`). The cron route builds it **once** before the loop and passes it into every iteration — a mid-batch save must not split one run across two title lists.

Bundle as one object rather than three sibling parameters: the companion plan adds a field to `RunContext` and no signature reopens.

- [ ] **Step 5: `app/actions/parse-role.ts` and the new `lib/fit-inputs.ts`**

Delete the local `CANDIDATE_BACKGROUND` (it moved to `lib/search-criteria.ts` in Task 2).

```ts
// lib/fit-inputs.ts
export interface FitInputs {
  fitBrain: string;
  // The companion compensation plan adds `compFloor: number | null` here.
  // Nothing else changes when it does — that is the point of this indirection.
}
```

```ts
// lib/search-criteria.ts — beside loadCriteria(), because the fit-brain
// default lives here; putting it in settings-store would be an import cycle.
export async function loadScoringInputs(): Promise<FitInputs> {
  const rows = await readAllSettings();
  return { fitBrain: mergeSettings(DEFAULT_CRITERIA, rows).fitBrain };
}
```

```ts
// app/actions/parse-role.ts
export async function scoreFit(opts: {
  company: string;
  role_title: string;
  company_description: string;
  key_skills: string;
  fit_summary: string;
  department: string;
  location: string;
  arr?: string;
  exit_signal?: string;
  backer?: string;
  fitInputs: FitInputs | null;   // REQUIRED key. null = "load from settings now"
}): Promise<{ score: number; rationale: string; error?: string }> {
  const { fitBrain } = opts.fitInputs ?? (await loadScoringInputs());
```

Why the key is **required** while its value may be null: omission would be
indistinguishable from "I meant the default", and the companion plan adds a
money value to this same object where that ambiguity becomes a real bug.
Required forces every call site to state intent — omission is a compile error.
`null` does not mean "use a shipped default"; it loads the user's actual stored
values, so a manually-added role is scored against the edited brain.

- [ ] **Step 6: Update all three `scoreFit` callers**

- `lib/ingest-roles.ts:141` — add `fitInputs: FitInputs` to `IngestOptions` and pass it straight through. **Carry `FitInputs`, not `Criteria`**: `ingestRoles` uses nothing else from criteria, and the narrower type stops the companion plan re-widening the same interface. Update its three callers (`app/actions/roles.ts`, `app/actions/role-search.ts`, `lib/crawler.ts`) to pass what they already loaded.
- `components/RolesTable.tsx:514` — pass `fitInputs: null`.
- `components/RecruiterPanel.tsx:74` — pass `fitInputs: null`.

Batch paths must always pass explicitly. Letting the `null` fallback fire inside a loop costs one settings read per scored row.

- [ ] **Step 7: Verify the build and full suite**

Run: `npm run build && npm test`
Expected: clean, all tests passing. The typechecker is the real gate here — it will name every call site you missed.

- [ ] **Step 8: Commit**

```bash
git add app/actions lib/crawler.ts lib/ingest-roles.ts
git commit -m "refactor: load criteria at call sites instead of importing constants"
```

---

### Task 4: Validation

**Files:**
- Create: `lib/criteria-validation.ts`
- Create: `lib/criteria-validation.test.ts`

**Interfaces:**
- Produces: `validateList(items, label)` and `normalizeList(items)`, returning `{ ok: true; value: string[] } | { ok: false; error: string }`.
- Consumed by: Task 6 (the save actions).

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test } from "vitest";
import { normalizeList, validateList } from "./criteria-validation";

describe("normalizeList", () => {
  test("trims entries and drops blanks", () => {
    expect(normalizeList(["  A  ", "", "   ", "B"])).toEqual(["A", "B"]);
  });

  test("de-duplicates case-insensitively, keeping the first spelling", () => {
    expect(normalizeList(["Clay", "clay", "CLAY"])).toEqual(["Clay"]);
  });

  test("collapses internal whitespace, including U+00A0", () => {
    expect(normalizeList(["Head  of" + "\xa0" + "RevOps"])).toEqual(["Head of RevOps"]);
  });
});

describe("validateList", () => {
  test("rejects an empty list by name", () => {
    const r = validateList([], "Target titles");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Target titles");
  });

  test("rejects a list that is empty only after normalizing", () => {
    expect(validateList(["  ", ""], "Locations").ok).toBe(false);
  });

  test("rejects a double quote, which would break query construction", () => {
    const r = validateList(['Head of "Revenue" Ops'], "Target titles");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('"');
  });

  test("accepts a normal list and returns it normalized", () => {
    const r = validateList([" GTM Engineer ", "GTM Engineer"], "Target titles");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(["GTM Engineer"]);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npm test -- criteria-validation`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/criteria-validation.ts`**

```ts
export type ValidationResult =
  | { ok: true; value: string[] }
  | { ok: false; error: string };

/**
 * Trim, collapse internal whitespace (\s covers U+00A0, which scraped and
 * pasted titles are full of), drop blanks, and de-duplicate case-insensitively
 * while keeping the first spelling the user typed.
 */
export function normalizeList(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const cleaned = raw.replace(/\s+/g, " ").trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}

export function validateList(items: string[], label: string): ValidationResult {
  const value = normalizeList(items);

  if (value.length === 0) {
    return {
      ok: false,
      // An empty list is the worst possible save: the crawler would extract
      // nothing from every tracked company and report "no roles" forever, with
      // no error anywhere. Blocked rather than warned.
      error: `${label} cannot be empty — an empty list makes every search and every crawl return nothing. Add at least one entry, or use Reset to defaults.`,
    };
  }

  const quoted = value.find((v) => v.includes('"'));
  if (quoted) {
    return {
      ok: false,
      // titleQueries builds `"${title}" ${place} job opening`; an embedded
      // quote produces a malformed search that fails silently.
      error: `Remove the " character from "${quoted}" — search queries wrap each entry in quotes, so an embedded quote produces a malformed search.`,
    };
  }

  return { ok: true, value };
}
```

- [ ] **Step 4: Run and verify they pass**

Run: `npm test -- criteria-validation`
Expected: PASS, 7 tests.

- [ ] **Step 5: Byte-verify the U+00A0 test**

```bash
LC_ALL=C grep -c $'\xc2\xa0' lib/criteria-validation.test.ts
```

Expected: `0` — the test must build the character from the `"\xa0"` escape, not contain a pasted literal. Report the result.

- [ ] **Step 6: Commit**

```bash
git add lib/criteria-validation.ts lib/criteria-validation.test.ts
git commit -m "feat: validate criteria lists on save"
```

---

### Task 5: The cost estimate

**Files:**
- Create: `lib/cost-estimate.ts`
- Create: `lib/cost-estimate.test.ts`

**Interfaces:**
- Produces: `estimateRunCost({ titles, locations, stackTerms, ceiling })` returning `{ titleQueries, stackQueries, searches, dollars }`.
- Consumed by: Task 6 (the settings page display).

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test } from "vitest";
import { estimateRunCost } from "./cost-estimate";

describe("estimateRunCost", () => {
  test("counts the title and stack grids separately", () => {
    const e = estimateRunCost({ titles: 13, locations: 3, stackTerms: 8, ceiling: null });
    expect(e.titleQueries).toBe(39);
    expect(e.stackQueries).toBe(24);
  });

  test("without a ceiling, searches equal the larger grid", () => {
    const e = estimateRunCost({ titles: 13, locations: 3, stackTerms: 8, ceiling: null });
    expect(e.searches).toBe(39);
  });

  test("a ceiling caps the searches", () => {
    const e = estimateRunCost({ titles: 13, locations: 3, stackTerms: 8, ceiling: 15 });
    expect(e.searches).toBe(15);
  });

  test("a ceiling above the grid does not inflate the estimate", () => {
    const e = estimateRunCost({ titles: 2, locations: 2, stackTerms: 2, ceiling: 100 });
    expect(e.searches).toBe(4);
  });

  test("cost rises with the grid", () => {
    const small = estimateRunCost({ titles: 2, locations: 1, stackTerms: 2, ceiling: null });
    const big = estimateRunCost({ titles: 20, locations: 3, stackTerms: 8, ceiling: null });
    expect(big.dollars).toBeGreaterThan(small.dollars);
  });

  test("pins an absolute figure, not just a trend", () => {
    // A units typo (3 / 1_000 instead of 3 / 1_000_000, or DOLLARS_PER_SEARCH
    // at 0.1) passes every other test in this suite. This is the only one that
    // catches it.
    const e = estimateRunCost({ titles: 13, locations: 3, stackTerms: 8, ceiling: null });
    expect(e.dollars).toBeGreaterThan(1.0);
    expect(e.dollars).toBeLessThan(1.3);
  });

  test("an empty grid costs nothing", () => {
    const e = estimateRunCost({ titles: 0, locations: 3, stackTerms: 0, ceiling: null });
    expect(e.searches).toBe(0);
    expect(e.dollars).toBe(0);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npm test -- cost-estimate`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/cost-estimate.ts`**

```ts
// Deliberately approximate — surfaced in the UI as "~$X". Its job is making
// the Denver/Colorado overlap visible (those two terms cover nearly the same
// ground and account for a third of the grid), not precise billing.
const DOLLARS_PER_SEARCH = 0.01; // web_search server tool, ~$10 per 1,000
const TOKENS_PER_SEARCH_RESULT = 5_000; // results entering context, observed order of magnitude
const DOLLARS_PER_INPUT_TOKEN = 3 / 1_000_000; // claude-sonnet-4-6 input
const FIT_SCORING_DOLLARS = 0.19; // up to 25 scoreFit calls per run

export interface EstimateInput {
  titles: number;
  locations: number;
  stackTerms: number;
  ceiling: number | null;
}

export interface Estimate {
  titleQueries: number;
  stackQueries: number;
  searches: number;
  dollars: number;
}

export function estimateRunCost(input: EstimateInput): Estimate {
  const titleQueries = input.titles * input.locations;
  const stackQueries = input.stackTerms * input.locations;
  // A run is one family at a time; the larger grid is the worst case.
  const grid = Math.max(titleQueries, stackQueries);
  const searches = input.ceiling != null ? Math.min(grid, input.ceiling) : grid;

  const dollars =
    searches === 0
      ? 0
      : searches * DOLLARS_PER_SEARCH +
        searches * TOKENS_PER_SEARCH_RESULT * DOLLARS_PER_INPUT_TOKEN +
        FIT_SCORING_DOLLARS;

  return { titleQueries, stackQueries, searches, dollars };
}
```

- [ ] **Step 4: Run and verify they pass**

Run: `npm test -- cost-estimate`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/cost-estimate.ts lib/cost-estimate.test.ts
git commit -m "feat: add per-run cost estimate"
```

---

### Task 6: Settings server actions

**Files:**
- Create: `app/actions/settings.ts`

**Interfaces:**
- Consumes: Task 1 store, Task 2 `DEFAULT_CRITERIA`/`Criteria`, Task 4 validation.
- Produces: `getSettings()`, `saveCriteriaList(key, label, items)`, `saveCriteriaText(key, label, text)`, `saveCeiling(n)`, `resetSetting(key)`, `getCriteriaChangedAt()`, `rescoreAll()`. (Three-arg save signatures — the originally-stated two-arg forms were wrong. There is no `countStaleScores`.)

- [ ] **Step 1: Create `app/actions/settings.ts`**

```ts
"use server";

import { loadCriteria, DEFAULT_CRITERIA, type Criteria } from "@/lib/search-criteria";
import { validateList } from "@/lib/criteria-validation";
import {
  SETTING_KEYS,
  deleteSetting,
  readAllSettings,
  writeSetting,
  type SettingKey,
} from "@/lib/settings-store";
import { rawQuery, supabase } from "@/lib/supabase";

export interface SettingsView {
  criteria: Criteria;
  ceiling: number | null;
  scoredJobCount: number;
  fitBrainOverridden: boolean;
  error?: string;
}

export async function getSettings(): Promise<SettingsView> {
  // ONE read of app_settings, then derive. loadCriteria() would read it a
  // second time, and layering readCeiling() on top would make it three.
  const [rows, scored] = await Promise.all([readAllSettings(), countScoredJobs()]);
  const ceilingRow = rows.find((r) => r.key === SETTING_KEYS.searchCeiling);
  return {
    criteria: mergeSettings(DEFAULT_CRITERIA, rows),
    ceiling: typeof ceilingRow?.value === "number" ? ceilingRow.value : null,
    scoredJobCount: scored,
    // Gates the rescore prompt across page loads — a client component has no
    // memory, so "re-show it this session" would bury it on a fresh load.
    fitBrainOverridden: rows.some((r) => r.key === SETTING_KEYS.fitBrain),
  };
}

async function countScoredJobs(): Promise<number> {
  const { data, error } = await rawQuery<{ n: string }>(
    `select count(*) n from jobs where fit_score is not null`
  );
  if (error) {
    console.error(`settings: could not count scored jobs — ${error.message}`);
    return 0;
  }
  return Number(data?.[0]?.n ?? 0);
}
```

- [ ] **Step 2: Add the list save, with validation and cache clearing**

```ts
// Which caches a given setting invalidates. Roles live in `jobs` and are never
// touched — role_searches and discovered_roles hold cached API responses, and
// every role in them was already written to jobs by ingestRoles at search
// time, so clearing them discards nothing the user found.
//
// discovered_startups is deliberately absent: funding results barely depend on
// criteria (the location rule is only a soft ranking hint there) and they are
// the most expensive cache to regenerate.
const CACHES_TO_CLEAR: Record<string, string[]> = {
  [SETTING_KEYS.titles]: ["role_searches", "discovered_roles"],
  [SETTING_KEYS.locations]: ["role_searches", "discovered_roles"],
  [SETTING_KEYS.stackTerms]: ["role_searches"],
  [SETTING_KEYS.locationRule]: ["role_searches", "discovered_roles"],
  [SETTING_KEYS.fitBrain]: [],
  [SETTING_KEYS.searchCeiling]: [],
};

// Only the settings that change what a SEARCH asks for reset the crawler's
// closure debounce. The fit brain and the ceiling do not affect what the
// crawler looks for, so stamping on them would needlessly suppress closure.
const AFFECTS_CRAWL: SettingKey[] = [
  SETTING_KEYS.titles,
  SETTING_KEYS.locations,
  SETTING_KEYS.locationRule,
];

async function clearCachesFor(key: SettingKey): Promise<void> {
  for (const table of CACHES_TO_CLEAR[key] ?? []) {
    const { error } = await rawQuery(`delete from ${table}`);
    if (error) {
      console.error(`settings: could not clear ${table} — ${error.message}`);
    }
  }
}

export async function saveCriteriaList(
  key: SettingKey,
  label: string,
  items: string[]
): Promise<{ error?: string }> {
  const result = validateList(items, label);
  if (!result.ok) return { error: result.error };

  const { error } = await writeSetting(key, result.value);
  if (error) return { error: `Could not save ${label} — ${error}` };

  await clearCachesFor(key);
  if (AFFECTS_CRAWL.includes(key)) await markCriteriaChanged();
  return {};
}

export async function saveCriteriaText(
  key: SettingKey,
  label: string,
  text: string
): Promise<{ error?: string }> {
  const trimmed = text.trim();
  if (!trimmed) return { error: `${label} cannot be empty.` };

  const { error } = await writeSetting(key, trimmed);
  if (error) return { error: `Could not save ${label} — ${error}` };

  await clearCachesFor(key);
  if (AFFECTS_CRAWL.includes(key)) await markCriteriaChanged();
  return {};
}
```

- [ ] **Step 3: Add the criteria-changed stamp**

This is what Task 7 reads to reset the crawler's closure debounce.

```ts
const CRITERIA_CHANGED_KEY = "criteria_changed_at";

async function markCriteriaChanged(): Promise<void> {
  const { error } = await rawQuery(
    `insert into app_settings (key, value, updated_at)
     values ($1, $2::jsonb, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [CRITERIA_CHANGED_KEY, JSON.stringify(new Date().toISOString())]
  );
  if (error) {
    console.error(`settings: could not stamp criteria change — ${error.message}`);
  }
}

export async function getCriteriaChangedAt(): Promise<string | null> {
  const { data } = await rawQuery<{ value: string }>(
    `select value #>> '{}' as value from app_settings where key = $1`,
    [CRITERIA_CHANGED_KEY]
  );
  return data?.[0]?.value ?? null;
}
```

- [ ] **Step 4: Add ceiling, reset, and rescore**

```ts
export async function saveCeiling(n: number | null): Promise<{ error?: string }> {
  if (n !== null && (!Number.isInteger(n) || n < 1)) {
    return { error: "The search ceiling must be a whole number of at least 1, or off." };
  }
  const { error } =
    n === null
      ? await deleteSetting(SETTING_KEYS.searchCeiling)
      : await writeSetting(SETTING_KEYS.searchCeiling, n);
  return { error: error ? `Could not save the search ceiling — ${error}` : undefined };
}

export async function resetSetting(key: SettingKey): Promise<{ error?: string }> {
  const { error } = await deleteSetting(key);
  if (error) return { error: `Could not reset — ${error}` };
  await clearCachesFor(key);
  await markCriteriaChanged();
  return {};
}

/**
 * Re-scores every job that already has a score, against the current fit brain.
 * Offered rather than automatic: an edit that fixes a typo should not silently
 * spend money, and the user decides each time.
 */
export async function rescoreAll(): Promise<{ rescored: number; error?: string }> {
  const fitInputs = await loadScoringInputs();
  let failed = 0;
  // rawQuery, NOT the builder. `.neq("fit_score", null)` renders
  // `"fit_score" <> $1` with $1 = null, which is never true in Postgres — it
  // returns zero rows and reports success. Verified against lib/supabase.ts.
  //
  // Every column here is read and weighted by scoreFit (parse-role.ts:164-169,
  // and the FINANCIAL SIGNALS block at :188-193). Dropping arr / exit_signal /
  // backer / company_description does not merely fail to improve scores — it
  // ACTIVELY DEGRADES them: a role scored 4 on "$380M+ ARR, PE exit planned"
  // gets rescored blind and drops.
  const { data, error } = await rawQuery<JobRow>(
    `select id, company, role_title, company_description, department, location,
            key_skills, fit_summary, arr, exit_signal, backer
       from jobs
      where fit_score is not null`
  );

  if (error) return { rescored: 0, error: `Could not read jobs — ${error.message}` };

  const rows = data ?? [];

  const { scoreFit } = await import("@/app/actions/parse-role");
  const { updateJob } = await import("@/app/actions/jobs");

  let rescored = 0;
  for (const row of rows) {
    const scored = await scoreFit({
      company: row.company,
      role_title: row.role_title,
      company_description: row.company_description ?? "",
      key_skills: row.key_skills ?? "",
      fit_summary: row.fit_summary ?? "",
      department: row.department ?? "",
      location: row.location ?? "",
      arr: row.arr ?? undefined,
      exit_signal: row.exit_signal ?? undefined,
      backer: row.backer ?? undefined,
      fitInputs,
    });
    if (scored.score > 0) {
      // Check the write before counting it. updateJob returns { error?: string }
      // (app/actions/jobs.ts:55); lib/crawler.ts:346-359 fixed exactly this
      // "counted a failed write as a success" bug — do not reintroduce it.
      const { error: updErr } = await updateJob(row.id, { fit_score: scored.score });
      if (updErr) {
        console.error(`rescoreAll: update failed for ${row.company} — ${updErr}`);
        failed++;
        continue;
      }
      rescored++;
    }
  }
  console.log(
    `rescoreAll: rescored ${rescored} of ${rows.length} scored jobs, ${failed} write failures`
  );
  return { rescored, failed };
}
```

**Do not write `fit_summary` back.** It is both an input to the prompt
(`Summary: ${opts.fit_summary}`) and the field the original plan overwrote with
`scored.rationale`. Rescore twice and the model is summarizing its own previous
rationale instead of the posting. Update `fit_score` only.

- [ ] **Step 5: Verify the build**

Run: `npm run build && npm test`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add app/actions/settings.ts
git commit -m "feat: add settings server actions"
```

---

### Task 7: Stop a criteria change from auto-closing live roles

**Files:**
- Modify: `lib/crawler.ts`
- Modify: `lib/crawler.test.ts`

**Interfaces:**
- Consumes: `getCriteriaChangedAt` (Task 6), `RunContext` (Task 3).
- Produces: nothing new; changes `closeStalePostings` behavior.

Read the doc comment above `titlesToClose` in `lib/crawler.ts` before starting. This task extends the principle already written there.

- [ ] **Step 1: Write the failing test**

Append to `lib/crawler.test.ts`:

```ts
import { runsEligibleForClosure } from "./crawler";

describe("runsEligibleForClosure", () => {
  const RUNS = [
    { finished_at: "2026-08-10T00:00:00Z", titles: ["a"] },
    { finished_at: "2026-08-03T00:00:00Z", titles: ["a"] },
  ];

  test("all runs count when criteria have never changed", () => {
    expect(runsEligibleForClosure(RUNS, null).length).toBe(2);
  });

  test("runs older than the criteria change are excluded", () => {
    expect(runsEligibleForClosure(RUNS, "2026-08-05T00:00:00Z").length).toBe(1);
  });

  test("a change newer than every run leaves nothing eligible", () => {
    expect(runsEligibleForClosure(RUNS, "2026-08-12T00:00:00Z")).toEqual([]);
  });

  test("a run exactly at the change timestamp is excluded, not included", () => {
    expect(runsEligibleForClosure(RUNS, "2026-08-10T00:00:00Z").length).toBe(0);
  });

  test("returns the runs themselves, not just a count", () => {
    const eligible = runsEligibleForClosure(RUNS, "2026-08-05T00:00:00Z");
    expect(eligible.length).toBeGreaterThan(0);
    expect(eligible[0].titles).toEqual(["a"]);
  });

  test("an unparseable cutoff falls back to trusting every run", () => {
    // Guards the Number.isNaN branch. Getting this wrong disables closure
    // permanently and silently.
    expect(runsEligibleForClosure(RUNS, "garbage").length).toBe(2);
  });

  test("a run with an unparseable finished_at is dropped loudly, not silently", () => {
    // crawl_runs.finished_at is nullable (db/schema.sql:107) — a 'running' row
    // has none. It must not be treated as newer than the cutoff.
    const withNull = [{ finished_at: null as unknown as string, titles: ["x"] }, ...RUNS];
    const eligible = runsEligibleForClosure(withNull, "2026-08-05T00:00:00Z");
    expect(eligible.some((r) => r.titles[0] === "x")).toBe(false);
    expect(eligible.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm test -- crawler`
Expected: FAIL — `runsEligibleForClosure is not a function`.

- [ ] **Step 3: Implement it**

```ts
export interface ClosureRun {
  finished_at: string;
  titles: string[];
}

/**
 * Which past crawl runs may be used as evidence that a posting is gone.
 *
 * titlesToClose already refuses to close on 'error' or 'needs_url' runs,
 * because a fetch failure is not evidence a job vanished. Editing the title
 * list is the same class of non-evidence: the crawler simply stopped looking
 * for that title, so its absence from a later run says nothing about whether
 * the posting is still up. Runs from before the change are therefore dropped,
 * which pushes the count under titlesToClose's two-run minimum and closes
 * nothing until two clean runs have happened under the current criteria.
 *
 * A run exactly at the change timestamp is excluded: it may have been in
 * flight when the save landed.
 */
export function runsEligibleForClosure(
  runs: ClosureRun[],
  criteriaChangedAt: string | null
): ClosureRun[] {
  if (!criteriaChangedAt) return runs;
  const cutoff = Date.parse(criteriaChangedAt);
  if (Number.isNaN(cutoff)) return runs;
  return runs.filter((r) => {
    const at = Date.parse(r.finished_at);
    if (Number.isNaN(at)) {
      // A nullable/unfinalized finished_at must not silently count as evidence.
      console.warn(
        `runsEligibleForClosure: run with unparseable finished_at "${r.finished_at}" excluded`
      );
      return false;
    }
    return at > cutoff;
  });
}
```

- [ ] **Step 4: Plumb `finished_at` through — the data does not exist yet**

`runsEligibleForClosure` needs `{ finished_at, titles }`, but today:
`LAST_TRUSTWORTHY_RUN_SQL` (`lib/crawler.ts:282`) selects `role_titles` only,
`lastSuccessfulTitles` returns `string[][]`, and the **current** run has no
`finished_at` at all — its `crawl_runs` row is not finalized until line 528.

Passing `null`/`undefined` there makes `Date.parse` yield `NaN`, `NaN > cutoff`
is `false`, the current run is dropped from evidence, and **closure is disabled
permanently after the first criteria change** — silently. Four concrete changes:

1. `LAST_TRUSTWORTHY_RUN_SQL` selects `role_titles, finished_at`. **Preserve the
   `status in ('ok', 'empty')` substring** — `lib/crawler.test.ts:124` and `:128`
   pin it.
2. `lastSuccessfulTitles` returns `ClosureRun[]`.
3. The current run is constructed literally as
   `{ finished_at: new Date().toISOString(), titles: seenTitles }`.
4. `closeStalePostings(company, runs: ClosureRun[], criteriaChangedAt: string | null)`
   maps `.map(r => r.titles)` before calling `titlesToClose`.

`criteriaChangedAt` arrives on the `RunContext` built in Task 3 Step 4 — do not
re-read it per company. Add a log line when a change suppresses closure:

```ts
if (eligible.length < runs.length) {
  console.log(
    `closeStalePostings(${company}): ${runs.length - eligible.length} run(s) predate ` +
      `the last criteria change and were excluded from closure evidence`
  );
}
```

- [ ] **Step 5: Run the full suite**

Run: `npm run build && npm test`
Expected: clean. Note the four `buildExtractionPrompt` tests were already updated in Task 3 Step 4 for its new signature; the rest of the crawler suite is untouched by this task.

- [ ] **Step 6: Commit**

```bash
git add lib/crawler.ts lib/crawler.test.ts
git commit -m "fix: a criteria change resets the stale-posting closure debounce"
```

---

### Task 8: The settings page

**Files:**
- Create: `app/settings/page.tsx`
- Create: `components/Settings.tsx`
- Create: `components/RescorePrompt.tsx`
- Modify: `components/Nav.tsx`
- Modify: `lib/criteria-validation.ts` (add the text-length guard)

**Interfaces:**
- Consumes: everything from Tasks 4, 5, 6.
- Produces: nothing consumed by later tasks in this plan. The companion compensation plan adds a section to `components/Settings.tsx`.

Read `components/Watchlist.tsx` first and match its visual language — this repo's components share a palette (`ink`, `canvas`, `slate`) and a plain-`fetch`-free server-action pattern. Do not introduce new colors or a form library.

- [ ] **Step 1: Add the nav tab**

In `components/Nav.tsx`, append to `TABS`:

```tsx
  { label: "Settings", href: "/settings" },
```

- [ ] **Step 2: Create the route**

`app/settings/page.tsx` follows the same shape as `app/watchlist/page.tsx` — read it and mirror it, rendering `<Settings />`.

- [ ] **Step 3: Build `components/Settings.tsx`**

A client component with five independently-saving sections. Requirements, each of which the reviewer will check:

1. **Sections:** Target titles (list), Locations (list), GTM stack terms (list), Location rule (textarea), Fit brain (textarea). Each has its own Save button and its own Reset to defaults.
2. **Titles section carries a warning that names the count.** Editing titles also changes what the weekly crawler hunts for on every tracked company and what Find roles searches for — the least obvious consequence of this page. When titles are being removed, compute N (crawl-sourced, still-`New` jobs whose titles match what is going away) and say: *"N tracked roles match titles you are removing. They stay on /roles, and the crawler will stop monitoring them."* A static warning with no number does not satisfy the spec.
3. **The estimate** renders under the titles and locations sections and recomputes as the user edits, before saving: `13 titles × 3 locations = 39 queries · ~$1.13 per By Role run`. Use `estimateRunCost` from Task 5. Label it approximate.
4. **The ceiling** is a number input labeled in searches, with the dollar equivalent beside it, and an explicit off state. Default off.
5. **Save errors surface next to the section that failed**, naming it — not in one shared banner that a later action wipes. **A failed save leaves the form populated** with what the user typed; never reset it to the stored value on error.
6. **Extract the prompt as `components/RescorePrompt.tsx`** — the companion compensation plan imports it, and describing it only as inline behavior would guarantee two prompts with drifting copy:

```tsx
export default function RescorePrompt({ count, onRescore, onDismiss, busy }: {
  count: number; onRescore: () => void; onDismiss: () => void; busy: boolean;
})
```

It computes its own dollar figure from `count` (`count * 0.0075`, rounded to cents) so that constant has exactly one home, and owns the busy label. Copy: `Saved. N roles carry scores from before this edit. Rescore them for about $X? [Rescore] [Not now]`.

Gate it on `scoredJobCount > 0 && fitBrainOverridden` from `getSettings` — **not** on session state. A client component has no memory across page loads, so a session-scoped rule would never re-show the prompt on a fresh load, which is the burial the spec explicitly forbids.
7. **Rescore runs in the foreground** with a disabled button and honest label (`Rescoring 44 roles… (about a minute)`), because `rescoreAll` makes one API call per row.
8. **The fit brain warns above 4,000 characters** (today's is ~1,800). It is sent on every `scoreFit` call, so its length multiplies across a re-score. Add `validateText(text, label, maxChars)` to `lib/criteria-validation.ts` with tests; warn, do not block.
9. **Every async action is wrapped in try/catch/finally** so a rejected promise cannot leave a button permanently disabled. This repo has been bitten by exactly that.

- [ ] **Step 4: Verify the build**

Run: `npm run build && npm test`
Expected: clean.

- [ ] **Step 5: Browser verification — SKIPPED**

There are no credentials in this worktree. Record `SKIPPED — no credentials` in your report. Do not claim any UI path was exercised.

- [ ] **Step 6: Update `CLAUDE.md`**

Replace the sentence describing `CANDIDATE_BACKGROUND` and duplicated prompts with an accurate one: criteria now live in `app_settings`, edited at `/settings`, with `lib/search-criteria.ts` holding the defaults and `loadCriteria()` the reader. Note that `scoreFit` takes the fit brain as an argument. Keep the file's existing terse voice; do not add a changelog; never write `npm run lint`.

- [ ] **Step 7: Commit**

```bash
git add app/settings components/Settings.tsx components/Nav.tsx CLAUDE.md
git commit -m "feat: add settings page for editable search criteria"
```

---

## Verification checklist

- [ ] `npm run build && npm test` is clean.
- [ ] `app_settings` applied to the live database and idempotent on a second run.
- [ ] `/settings` renders, and each section saves independently.
- [ ] Saving an empty title list is blocked with a readable message.
- [ ] Saving a title containing `"` is blocked with a readable message.
- [ ] The estimate updates as lists are edited, before saving.
- [ ] Editing titles clears `role_searches` and `discovered_roles`; `jobs` row count is unchanged.
- [ ] Editing the fit brain offers a rescore with a dollar figure; declining changes nothing.
- [ ] Rescoring updates `fit_score` on existing rows.
- [ ] A crawl after a criteria change closes nothing; the suppression log line appears.
- [ ] Reset to defaults restores the shipped values.
- [ ] With `app_settings` empty, every search feature runs on the same criteria it did before this plan — with the one intended exception that the By Role run is uncapped by default (`max_uses` at `MAX_QUERY_MULTIPLIER ×` the query count) rather than capped at the old fixed `MAX_QUERIES_PER_SEARCH = 15`, i.e. ~$1.13 per run against ~$0.55.
