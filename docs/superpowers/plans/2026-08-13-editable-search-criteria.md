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

# REVIEW CORRECTIONS — authoritative, supersede the tasks below

Two independent reviews, then a cross-review. Where this section and a task
disagree, **this section wins**. Every item was verified against the real
source, not inferred from the plan.

## R1 (Critical, Task 3) — `scoreFit` has THREE callers, not one

Task 3 Step 6 says `lib/ingest-roles.ts:141` is the only call site. **False.**
Also `components/RolesTable.tsx:514` and `components/RecruiterPanel.tsx:74`,
both `"use client"`. Adding required fields fails `next build`. Neither can call
`loadCriteria()` — it transitively imports `pg`.

Final signature (adjudicated between the two reviewers):

```ts
// lib/fit-inputs.ts  — new file, this task
export interface FitInputs { fitBrain: string; compFloor: number | null }

// app/actions/parse-role.ts
export async function scoreFit(opts: {
  company: string; role_title: string; company_description: string;
  key_skills: string; fit_summary: string; department: string; location: string;
  arr?: string; exit_signal?: string; backer?: string;
  salary_range: string;            // REQUIRED — per-role data, no fallback exists
  fitInputs: FitInputs | null;     // REQUIRED key. null = "load from settings now"
}): Promise<{ score: number; rationale: string; error?: string }>
```

`const inputs = opts.fitInputs ?? (await loadScoringInputs());` at the top.
The key is **required** so every call site must state intent — omission is a
compile error. `null` does not mean "use a default"; it loads the user's real
stored values, so a manual add is scored against the edited brain, not the
shipped one. `compFloor: null` *inside* the object unambiguously means "floor
off" — the outer null and the inner null sit in different positions and cannot
be confused, which is why no `??` disambiguation is needed.

Batch paths (`ingestRoles`, `rescoreAll`, the crawl loop) **must always pass
explicitly** — letting the fallback fire there costs one settings read per
scored row. The two client call sites pass `fitInputs: null` and their existing
`form.salary_range`.

`IngestOptions` carries `fitInputs: FitInputs`, **not** `criteria: Criteria` —
`ingestRoles` uses nothing else from criteria, and the narrower type stops the
companion plan re-widening it.

## R2 (Critical, Task 3) — `buildExtractionPrompt` changes signature and breaks 4 tests

`lib/crawler.ts:34` is a **synchronous exported** function pinned by four tests
at `lib/crawler.test.ts:33-55`, including `toContain("Denver")` which comes from
`LOCATION_RULE`. New signature `buildExtractionPrompt(company, page, criteria)`;
update all four tests to pass `DEFAULT_CRITERIA`. Task 7 Step 5's claim that
"the 22 pre-existing crawler tests still pass" is wrong as written.

## R3 (Critical, Task 3/7) — `crawlCompany` has three callers; a batch load needs a signature change

There is no batch function in `lib/crawler.ts`. The loop is in
`app/api/cron/crawl/route.ts:79`; `crawlCompany` is also called from
`app/actions/watchlist.ts:226` and `:285`. Bundle the per-batch values as one
object rather than three sibling fields:

```ts
export interface RunContext {
  criteria: Criteria;
  fitInputs: FitInputs;
  criteriaChangedAt: string | null;
}
export async function crawlCompany(
  company: string,
  opts: { dryRun?: boolean; ctx?: RunContext } = {}
)
```

`ctx ?? await loadRunContext()` inside, for the two single-company callers. The
cron route loads it once before the loop. Name all three callers in the task.
The task's Files list must include `app/api/cron/crawl/route.ts` and
`app/actions/watchlist.ts`.

**Compensation must never enter `buildExtractionPrompt`.** It is a scoring input
only; putting it in extraction would create the ingest-time filter the spec
forbids.

## R4 (Critical, Task 6) — `.neq("fit_score", null)` matches zero rows, and the read drops four scoring columns

`lib/supabase.ts:108-111` renders `"fit_score" <> $1` with `$1 = null`. In
Postgres that is never true, so `rescoreAll` returns zero rows and logs
`rescored 0 of 0` — a success-shaped total failure.

Worse: the plan hardcodes `company_description: ""` and omits `arr`,
`exit_signal`, `backer`. All four are real columns that `scoreFit` reads and
weights (`app/actions/parse-role.ts:164-169`, and the FINANCIAL SIGNALS block at
:188-193). So rescoring does not merely fail to improve scores — **it actively
degrades them.** A role scored 4 on `$380M+ ARR, PE exit planned` gets rescored
blind and drops. Replace the builder call outright:

```ts
const { data, error } = await rawQuery<JobRow>(
  `select id, company, role_title, company_description, department, location,
          key_skills, fit_summary, arr, exit_signal, backer, salary_range
     from jobs
    where fit_score is not null`
);
```

Pass nullable text as `row.arr ?? undefined`, not `?? ""` — the prompt already
renders `opts.arr || "unknown"`.

Two more defects in the same function:
- **Check `updateJob`'s error before incrementing.** It returns `{ error?: string }`
  (`app/actions/jobs.ts:55`); the plan counts a failed write as a rescore.
  `lib/crawler.ts:346-359` fixed exactly this bug with a comment; do not
  reintroduce it.
- **Stop overwriting `fit_summary` on rescore.** It is both an input (`Summary:`
  in the prompt) and the output written back. Rescore twice and the model is
  summarizing its own previous rationale rather than the posting.

## R5 (Critical, Task 3) — `readCeiling()` is referenced but never defined

Task 3 Step 3 calls `readCeiling()` "from Task 6"; Task 6 never defines it, and
Task 3 precedes Task 6 anyway. Define the primitive in **Task 1**:

```ts
// lib/settings-store.ts
export async function readNumberSetting(key: SettingKey): Promise<number | null> {
  const rows = await readAllSettings();
  const row = rows.find((r) => r.key === key);
  return typeof row?.value === "number" ? row.value : null;
}
export const readCeiling = () => readNumberSetting(SETTING_KEYS.searchCeiling);
```

And the batch-tier reader in `lib/search-criteria.ts` beside `loadCriteria()`
(it belongs there because the fit-brain default lives there; putting it in the
store would create an import cycle):

```ts
export async function loadScoringInputs(): Promise<FitInputs> {
  const rows = await readAllSettings();
  const floor = rows.find((r) => r.key === SETTING_KEYS.compFloor)?.value;
  return {
    fitBrain: mergeSettings(DEFAULT_CRITERIA, rows).fitBrain,
    compFloor: typeof floor === "number" ? floor : null,
  };
}
```

`getSettings` must do **one** `readAllSettings()` and derive from it — as
written it reads the seven-row table twice, and adding the readers on top would
make it four.

## R6 (Critical, Task 7) — `runsEligibleForClosure` cannot be wired as described

`ClosureRun` needs `{ finished_at, titles }`, but `LAST_TRUSTWORTHY_RUN_SQL`
(`lib/crawler.ts:282`) selects `role_titles` only, `lastSuccessfulTitles` returns
`string[][]`, and the **current** run has no `finished_at` at all — its
`crawl_runs` row is not finalized until line 528. Passing `null`/`undefined`
makes `Date.parse` yield `NaN`, `NaN > cutoff` is `false`, the current run is
dropped, and **closure is disabled permanently after the first criteria change.**
Silent, and exactly the failure class this plan's constraints forbid.

The task must specify: (a) `LAST_TRUSTWORTHY_RUN_SQL` selects `role_titles,
finished_at`, preserving the `status in ('ok', 'empty')` substring that
`lib/crawler.test.ts:124` and `:128` pin; (b) `lastSuccessfulTitles` returns
`ClosureRun[]`; (c) the current run is constructed literally as
`{ finished_at: new Date().toISOString(), titles: seenTitles }`; (d)
`closeStalePostings(company, runs: ClosureRun[], criteriaChangedAt)` maps
`.map(r => r.titles)` before `titlesToClose`. Add tests for an unparseable
`criteriaChangedAt` and a `null` `finished_at` — both currently untested, and
`crawl_runs.finished_at` is nullable (`db/schema.sql:107`).

## R7 (Important, Task 1/2) — fix `SETTING_KEYS` casing in Task 1 and delete the Task 2 rename

Ship camelCase values (`stackTerms`, `locationRule`, `fitBrain`, `searchCeiling`,
`compFloor`) in Task 1 Step 4 and **delete Task 2 Step 3's rename paragraph
entirely.** The companion plan reads `SETTING_KEYS.compFloor` and would otherwise
consume Task 1's committed snake_case values.

Nothing currently enforces the invariant, and `mergeSettings` skips unknown keys
**by design** — so drift makes every save a silent no-op with no error anywhere.
Add a guard test. It must be **one-directional**: `compFloor` and `searchCeiling`
are not `Criteria` fields, so a bijection assertion would fail.

```ts
test("every Criteria field has a matching SETTING_KEYS value", () => {
  const fields = Object.keys(DEFAULT_CRITERIA);
  expect(fields.length).toBeGreaterThan(0);
  for (const f of fields) expect(Object.values(SETTING_KEYS)).toContain(f);
});
```

## R8 (Important, Task 1) — `mergeSettings` accepts a wrong-typed value

A row `{key: "titles", value: "a string"}` passes every guard and lands on
`criteria.titles`; `titleListForPrompt` then calls `.join` on a string and throws
mid-crawl. Skip a row whose shape does not match the default's
(`Array.isArray` mismatch, or `typeof` mismatch for scalars), log it, and test it.

## R9 (Important, Task 2) — the tree is unbuildable between Tasks 2 and 3

Task 2 deletes constants that four files still import, verifies with
`npm test -- search-criteria` (vitest does not typecheck), and commits. Either
merge Tasks 2 and 3 into one task with one commit, or state explicitly that the
build is intentionally red across this pair and suspend the "every task leaves
the baseline passing" rule for it. Do not leave it implicit.

## R10 (Important, Task 6) — interface block contradicts the implementation

Interfaces say `saveCriteriaList(key, items)`; the code is
`saveCriteriaList(key, label, items)`. Same for `saveCriteriaText`. It names
`countStaleScores()`, which nothing implements (the private helper is
`countScoredJobs`), and omits `getCriteriaChangedAt`, which Task 7 imports. Fix
the block to match, and have `countScoredJobs` return `number | null` so a failed
count is not silently rendered as "0 roles" — a wrong answer presented as fact.

## R11 (Important, Task 8) — extract `<RescorePrompt />`; the companion plan imports it

Task 8 describes the prompt only as inline behavior, so the companion plan has
nothing to import and will re-implement it, producing two prompts with drifting
copy. Ship `components/RescorePrompt.tsx`:

```tsx
export default function RescorePrompt({ count, onRescore, onDismiss, busy }: {
  count: number; onRescore: () => void; onDismiss: () => void; busy: boolean;
})
```

It computes the dollar figure from `count` internally (`count * 0.0075`, rounded
to cents) so the constant has one home, and owns the `busy` label.

Requirement 6's "re-show in this session" also contradicts the spec — a client
component has no memory across page loads, so the prompt would never reappear on
a fresh load, which is the burial the spec forbids. Have `getSettings` return
`fitBrainOverridden: boolean` (a `fitBrain` row exists in `app_settings`) and gate
on `scoredJobCount > 0 && fitBrainOverridden`.

## R12 (Important) — three spec requirements have no task

- **The save-time warning must name the count**: "N tracked roles match titles
  you are removing." Task 8 requirement 2 is a static warning; nothing computes N.
- **The 4,000-character fit-brain warning** exists nowhere —
  `lib/criteria-validation.ts` has no text validator at all.
- **"A failed save leaves the form populated"** is unstated in Task 8.

## R13 (Minor, verified) — smaller corrections

- Task 2 Step 5's byte-verify `sed` pattern misses `export const DEFAULT_FIT_BRAIN`.
- Task 6's `clearCachesFor` deletes all of `role_searches` for a stack-terms edit;
  the spec says the stack family only. Narrow it or state the widening.
- `markCriteriaChanged()` fires on a fit-brain save, needlessly suppressing crawler
  closure. Restrict it to `titles`, `locations`, `locationRule`.
- Task 5's `input.ceiling ?` treats `0` as "no ceiling"; use `!= null`.
- Task 8 Step 2 never says whether `getSettings()` is awaited server-side and
  passed as props or called from the client.
- The spec calls it `DEFAULT_CANDIDATE_BACKGROUND`; the plan uses
  `DEFAULT_FIT_BRAIN`. Pick one — the companion plan needs the same name.

## R14 — tests that pass against a broken implementation

Task 2's rewrite **loses three assertions** the originals had. Restore them:
- `pickQueries` at the **equality boundary** (`cap === length`), not just under it.
  An off-by-one from `<=` to `<` currently passes.
- `pickQueries` covers every **location term** — deleted, not replaced.
- `pickQueries` covers every **stack term** at the default cap — deleted, not
  replaced. Only title coverage survives, so a regression in the 24-query stack
  grid is uncaught.

Also: the default grid size (39) is now unasserted anywhere; `estimateRunCost`
has no absolute-value test, so `3 / 1_000` instead of `3 / 1_000_000` passes
every test in the suite — pin the headline case between $1.00 and $1.30; and
`validateList`'s quote test should assert the message names the offending entry.

---

### Task 1: The `app_settings` table and the settings store

**Files:**
- Modify: `db/schema.sql` (append `app_settings`)
- Create: `lib/settings-store.ts`
- Create: `lib/settings-store.test.ts`

**Interfaces:**
- Produces: `SETTING_KEYS` (const object), `type SettingKey`, `mergeSettings(defaults, rows)`, and async `readSetting(key)` / `writeSetting(key, value)` / `deleteSetting(key)`.
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
export const SETTING_KEYS = {
  titles: "titles",
  locations: "locations",
  stackTerms: "stack_terms",
  locationRule: "location_rule",
  fitBrain: "fit_brain",
  searchCeiling: "search_ceiling",
  compFloor: "comp_floor",
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
    (merged as Record<string, unknown>)[row.key] = row.value;
  }
  return merged;
}

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

Note the setting keys in `SETTING_KEYS` (`titles`, `locations`, `stack_terms`, …) must map onto the `Criteria` field names for `mergeSettings` to apply them. Use `Criteria`'s own field names as the stored keys — change `SETTING_KEYS` in `lib/settings-store.ts` to `stackTerms`, `locationRule`, `fitBrain`, `searchCeiling`, `compFloor` so the two agree, and update its test if needed. State in your report that you did this and why.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npm test -- search-criteria`
Expected: PASS.

- [ ] **Step 5: Byte-verify the moved fit brain**

The `CANDIDATE_BACKGROUND` string moved files. Confirm it is byte-identical:

```bash
git show HEAD:app/actions/parse-role.ts | sed -n '/^const CANDIDATE_BACKGROUND/,/^`.trim/p' > /tmp/before.txt
sed -n '/^const DEFAULT_FIT_BRAIN/,/^`.trim/p' lib/search-criteria.ts > /tmp/after.txt
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

**Interfaces:**
- Consumes: `loadCriteria`, `Criteria`, `titleQueries`, `stackQueries`, `titleListForPrompt`, `MAX_QUERY_MULTIPLIER`, `pickQueries` (Task 2).
- Produces: nothing new. This task only rewires.

All five files are already in async server contexts, so `await loadCriteria()` is safe in each.

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

- [ ] **Step 4: `lib/crawler.ts`**

`await loadCriteria()` where the extraction prompt is built, then `titleListForPrompt(criteria)` and `criteria.locationRule`. **Load once per crawl batch, not once per company** — the cron route crawls up to 10 companies in a loop, and reloading per company means a mid-batch save could split one run across two title lists. Thread the criteria object down from the batch entry point rather than calling `loadCriteria()` inside the per-company function.

- [ ] **Step 5: `app/actions/parse-role.ts`**

Delete the local `CANDIDATE_BACKGROUND` (it moved to `lib/search-criteria.ts` in Task 2). `scoreFit` takes the fit brain as an argument rather than reading a module constant:

```ts
export async function scoreFit(opts: {
  company: string;
  role_title: string;
  company_description: string;
  key_skills: string;
  fit_summary: string;
  department: string;
  location: string;
  fitBrain: string;
  arr?: string;
  exit_signal?: string;
  backer?: string;
}): Promise<{ score: number; rationale: string; error?: string }> {
```

Use `opts.fitBrain` where `CANDIDATE_BACKGROUND` appeared in the prompt.

- [ ] **Step 6: Update the single `scoreFit` caller**

`lib/ingest-roles.ts:141` is the only call site. `ingestRoles` must now receive the criteria. Add `criteria: Criteria` to `IngestOptions` and pass `fitBrain: opts.criteria.fitBrain` through to `scoreFit`. Update all `ingestRoles` callers (`app/actions/roles.ts`, `app/actions/role-search.ts`, `lib/crawler.ts`) to pass the criteria they already loaded — do not call `loadCriteria()` a second time inside `ingestRoles`.

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
  const searches = input.ceiling ? Math.min(grid, input.ceiling) : grid;

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
- Produces: `getSettings()`, `saveCriteriaList(key, items)`, `saveCriteriaText(key, text)`, `saveCeiling(n)`, `resetSetting(key)`, `countStaleScores()`, `rescoreAll()`.

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
  error?: string;
}

export async function getSettings(): Promise<SettingsView> {
  const [criteria, rows, scored] = await Promise.all([
    loadCriteria(),
    readAllSettings(),
    countScoredJobs(),
  ]);
  const ceilingRow = rows.find((r) => r.key === SETTING_KEYS.searchCeiling);
  const ceiling = typeof ceilingRow?.value === "number" ? ceilingRow.value : null;
  return { criteria, ceiling, scoredJobCount: scored };
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
  await markCriteriaChanged();
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
  await markCriteriaChanged();
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
  const criteria = await loadCriteria();
  const { data, error } = await supabase
    .from("jobs")
    .select("id, company, role_title, location, key_skills, fit_summary, department")
    .neq("fit_score", null);

  if (error) return { rescored: 0, error: `Could not read jobs — ${error.message}` };

  const rows = (data ?? []) as {
    id: string;
    company: string;
    role_title: string;
    location: string | null;
    key_skills: string | null;
    fit_summary: string | null;
    department: string | null;
  }[];

  const { scoreFit } = await import("@/app/actions/parse-role");
  const { updateJob } = await import("@/app/actions/jobs");

  let rescored = 0;
  for (const row of rows) {
    const scored = await scoreFit({
      company: row.company,
      role_title: row.role_title,
      company_description: "",
      key_skills: row.key_skills ?? "",
      fit_summary: row.fit_summary ?? "",
      department: row.department ?? "",
      location: row.location ?? "",
      fitBrain: criteria.fitBrain,
    });
    if (scored.score > 0) {
      await updateJob(row.id, {
        fit_score: scored.score,
        fit_summary: scored.rationale || row.fit_summary,
      });
      rescored++;
    }
  }
  console.log(`rescoreAll: rescored ${rescored} of ${rows.length} scored jobs`);
  return { rescored };
}
```

Note `.neq("fit_score", null)` may not express `IS NOT NULL` in this builder — read `lib/supabase.ts` first and use `rawQuery` if it does not. Report which you used.

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
- Consumes: `getCriteriaChangedAt` (Task 6).
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
  return runs.filter((r) => Date.parse(r.finished_at) > cutoff);
}
```

- [ ] **Step 4: Wire it into `closeStalePostings`**

Fetch `getCriteriaChangedAt()` once per batch (alongside the criteria from Task 3, Step 4) and thread it in. Filter the trustworthy-runs list through `runsEligibleForClosure` before passing it to `titlesToClose`. Add a log line when a change suppresses closure, so the behavior is visible:

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
Expected: clean; the 22 pre-existing crawler tests still pass.

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
- Modify: `components/Nav.tsx`

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
2. **Titles section carries a plain-language warning** that editing it also changes what the weekly crawler looks for on every tracked company, and what the per-company Find roles button searches for. This is the least obvious consequence of the page.
3. **The estimate** renders under the titles and locations sections and recomputes as the user edits, before saving: `13 titles × 3 locations = 39 queries · ~$1.13 per By Role run`. Use `estimateRunCost` from Task 5. Label it approximate.
4. **The ceiling** is a number input labeled in searches, with the dollar equivalent beside it, and an explicit off state. Default off.
5. **Save errors surface next to the section that failed**, naming it — not in one shared banner that a later action wipes.
6. **After a successful fit-brain save**, show a dismissible prompt: `Saved. N roles carry scores from before this edit. Rescore them for about $X? [Rescore] [Not now]` where N is `scoredJobCount` and X is `N × 0.0075` rounded to cents. Re-show it whenever the page loads while `scoredJobCount > 0` and the fit brain differs from what was last scored — since there is no version column, re-show it on every load after any fit-brain save in this session, and accept that it is dismissible.
7. **Rescore runs in the foreground** with a disabled button and honest label (`Rescoring 44 roles… (about a minute)`), because `rescoreAll` makes one API call per row.
8. **Every async action is wrapped in try/catch/finally** so a rejected promise cannot leave a button permanently disabled. This repo has been bitten by exactly that.

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
- [ ] With `app_settings` empty, every search feature behaves exactly as it did before this plan.
