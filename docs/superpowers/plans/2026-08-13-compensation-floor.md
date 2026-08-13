# Compensation Floor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the already-captured `salary_range` string into something the app uses — a parsed base-compensation range, a user-set minimum floor, two filters on `/roles`, and compensation as an input to fit scoring.

**Architecture:** Salary parses at read time rather than at ingest, so the floor applies retroactively to existing rows with no migration or backfill, and improving the parser later fixes historical rows for free. Nothing is filtered at ingest: 48% of rows have no range at all, and a blank often means the extractor missed one rather than the employer withheld it, so dropping on a blank would drop on extraction failure — invisibly and irreversibly.

**Tech Stack:** Next.js 14 App Router, TypeScript, Tailwind, Railway Postgres via `lib/supabase.ts`, Anthropic SDK, vitest.

**Spec:** `docs/superpowers/specs/2026-08-13-search-settings-design.md`

**Prerequisite:** `docs/superpowers/plans/2026-08-13-editable-search-criteria.md` must be complete. This plan consumes its `app_settings` table and settings store (Task 1), its `Criteria` type and `loadCriteria()` (Task 2), its `scoreFit({ ..., fitBrain })` signature (Task 3), its settings server actions (Task 6), and its `components/Settings.tsx` (Task 8).

## Global Constraints

- **The pre-deploy gate is `npm run build && npm test`.** `npm run lint` has never worked in this repo — no ESLint config, `next lint` blocks on an interactive prompt, and adding a config makes `next build` fail on 3 pre-existing errors. Never add it to any gate.
- **No API routes.** Server actions in `app/actions/`, shared machinery in `lib/`.
- **`lib/supabase.ts` is NOT Supabase** — a hand-rolled builder over `pg` whose filter surface is only `.eq()` / `.neq()`. Anything else requires `rawQuery()`.
- **No new columns and no migration.** Parsing happens at read time against the existing `jobs.salary_range` text.
- **Never filter at ingest.** Compensation affects display and scoring only.
- **Explicit over silent.** An unparseable salary string is logged, never silently treated as absent.
- **Pure logic lives in `lib/*.ts` with a sibling `lib/*.test.ts`** (vitest). Server actions and React components are not unit-tested in this repo.
- **Every test must fail against a broken implementation.** Pair any `.every` assertion with a non-empty length assertion.

---

# REVIEW CORRECTIONS — authoritative, supersede the tasks below

Two independent reviews, then a cross-review. Where this section and a task
disagree, **this section wins**. The parser was hand-traced and executed against
all six real production strings by a reviewer, and independently re-run by the
controller.

## R1 (Critical, Task 3) — OTE-only roles get hidden by the floor filter, contradicting the spec

`salaryBucketFor` returns `"below"` when `baseMaxFor` is null (the OTE case), and
Step 5 hides `below`. So `$300,000 - $340,000 OTE` — a role whose base almost
certainly clears any realistic floor — **disappears the moment the toggle is on**,
grouped with genuinely underpaying roles. The spec says the opposite: *"An
OTE-only figure is not base. Surface it as OTE; do not compare it to a base
floor."* Bucketing it with below-floor roles **is** comparing it to the floor.

Make `"ote"` its own `SalaryBucket`. Group it with the "No range listed" toggle
(it is a *didn't tell me the base* fact, not a *pays too little* fact) or give it
its own tag and leave it always visible. Add:

```ts
expect(salaryBucketFor(job("$300,000 - $340,000 OTE"), 200000)).toBe("ote");
```

The existing test asserts `.not.toBe("meets")`, which passes for `below`,
`no-range`, and `unreadable` alike — it cannot catch the very bug it guards.

## R2 (Critical, Task 1) — `labeledBase` is dead code; the headline rule is unpinned

Base-over-OTE precedence is the most consequential decision in this plan, and
**deleting the `labeledBase` branch leaves all six production strings byte-identical
and all 9 tests passing.** Verified by execution, not inspection.

The two tests that look like they cover it do not: in
`$…(base); $…OTE`, `labeledBase` and `nonOte` are the same object; in
`$165,000 - $175,000 base + annual bonus` there is only one segment. Add a
fixture where the base label is **not** on the first segment:

```ts
expect(parseSalaryRange("$120,000 - $140,000 (Denver); $180,000 - $200,000 base (SF)"))
  .toEqual({ kind: "base", min: 180000, max: 200000 });
```

Verified: with `labeledBase` → `180000–200000`; without → `120000–140000`.

## R3 (Critical, Task 3/4) — no delivery path for `compFloor` into `RolesTable`

`components/RolesTable.tsx` is `"use client"`, loads via its own `getJobs()`, and
`app/roles/page.tsx` renders `<RolesTable />` with **zero props** (verified — the
file is five lines). The plan's "or wherever `RolesTable` receives its data"
resolves to nowhere.

Preferred fix: make `app/roles/page.tsx` a server component that awaits the floor
and passes `<RolesTable compFloor={…} />` — one read, no client round trip, no new
endpoint. Fallback if that is not workable: `getCompFloor()` in
`app/actions/settings.ts`, awaited alongside `getJobs()` in `load()`.

`readCompFloor` belongs in `lib/settings-store.ts` as a three-line wrapper over
the `readNumberSetting` primitive the prerequisite plan now ships:

```ts
export const readCompFloor = () => readNumberSetting(SETTING_KEYS.compFloor);
```

## R4 (Critical, Task 4) — the final `scoreFit` signature, adjudicated

`scoreFit` has **three** callers, not one: `lib/ingest-roles.ts:141`,
`components/RolesTable.tsx:514`, `components/RecruiterPanel.tsx:74`. The two
client callers cannot resolve settings themselves (`loadCriteria` transitively
imports `pg`). Final shape, agreed with the prerequisite plan:

```ts
salary_range: string;            // REQUIRED — per-role data, no fallback exists
fitInputs: FitInputs | null;     // REQUIRED key. null = "load from settings now"
```

`FitInputs` is `{ fitBrain: string; compFloor: number | null }`, defined by the
prerequisite plan. This plan adds `compFloor` to that interface and to
`loadScoringInputs()` — it does **not** re-open `scoreFit`'s argument list.

The outer `null` means "load the user's real stored values"; `compFloor: null`
*inside* the object means "the floor is off". Different positions, unambiguous,
no `??` disambiguation needed. Batch paths pass explicitly; only the two client
call sites pass `null`, and both already have `form.salary_range` in scope.

## R5 (Critical, Task 5) — do not ship until the prerequisite's `rescoreAll` is fixed

The prerequisite's `rescoreAll` uses `.neq("fit_score", null)`, which compiles to
`"fit_score" <> $1` with `$1 = null` and matches **zero rows**. It also drops
`company_description`, `arr`, `exit_signal`, and `backer` — all real columns
`scoreFit` weights (`app/actions/parse-role.ts:164-169`, :188-193).

So the day-one rescue button would either do nothing, or — where it does run —
**actively downgrade** the user's best-scored roles by rescoring them blind to
their financial signals. Add an explicit prerequisite line to Task 5: it must not
ship until the prerequisite plan's R4 correction is in.

Task 4 Step 3's own column list must be the complete one:

```ts
`select id, company, role_title, company_description, department, location,
        key_skills, fit_summary, arr, exit_signal, backer, salary_range
   from jobs where fit_score is not null`
```

via `rawQuery`, not the builder. Pass nullable text as `?? undefined`, not `?? ""`.

## R6 (Important, Task 1) — the parser rejects the format the app itself teaches

`$200K - $280K` returns `unparseable` — and that string is the literal
placeholder in `components/RolesTable.tsx:328`'s own salary editor. The app
teaches a format its parser rejects. `$150k` and `$1.5M` also fail.

Extend `MONEY` to accept a `k`/`K`/`m`/`M` suffix and scale it, or change the
placeholder. Add all three as fixtures either way — a silently-unparseable
manual entry shows as "no range listed" with no indication anything went wrong.

## R7 (Important, Task 1) — a comma-separated base/OTE pair produces a mangled range

`segments()` splits only on `;`. Verified:
`"$280,000 - $325,000 base, $305,000 - $365,000 OTE"` →
`{kind:"ote", min:280000, max:365000}` — a range spanning base-min to OTE-max,
then bucketed `below` by Task 3. Split on `/[;\n]|(?<=\))\s*,/`, or detect ≥3
money figures in one segment and pair them off. Add the comma case as a fixture.

## R8 (Important, Task 4) — compensation must never enter `buildExtractionPrompt`

An implementer threading `{criteria, compFloor}` down the crawler path may hand it
to extraction. That would create the ingest-time compensation filter both the
spec and this plan's Global Constraints forbid. State the prohibition in Task 4
Step 2 explicitly.

Also: `lib/crawler.ts:488`'s `ingestRoles` call sits inside `crawlCompany`, which
has three callers (`app/api/cron/crawl/route.ts:79`, `app/actions/watchlist.ts:226`,
`:285`). Task 4 Step 2 says "update the three `ingestRoles` callers" and names none
of them. Carry the whole `loadScoringInputs()` result as one object on the
`RunContext` the prerequisite plan introduces — zero extra call-site churn.

## R9 (Important, Task 4) — the AI-GTM rule can override the compensation input

`floorLine` is a soft preference sentence, but the prompt's AI-DRIVEN GTM
TRANSFORMATION RULE sets an unconditional floor score of 4 when three conditions
hold, none of which mention pay. A below-floor role at an established B2B SaaS
company with an AI-GTM mandate still floors at 4, so the spec's promise ("a
below-floor role scores low rather than disappearing") and the verification item
"rescoring after setting a floor changes scores on below-floor roles" both fail.

Add a compensation clause to the SCORING GUIDE and a carve-out in the floor-4
rule: *"If the posted base is below the candidate's stated minimum, cap at 3
regardless of this rule."*

## R10 (Important, Task 5) — the rescore prompt fires forever

Trigger is `scoredJobCount > 0`; behavior is "reappears until the user rescores."
Rescoring updates scores, it does not remove them — so the count never changes and
the prompt shows immediately after a successful rescore, forever. Write a
`comp_scoring_rescored_at` row into `app_settings` when `rescoreAll` completes and
suppress on it. That is a key/value **row**, not a column, so it respects the
no-migration constraint that ruled out a version column.

Also: import `<RescorePrompt />` from the prerequisite plan rather than
re-implementing it, and use its internal `count * 0.0075` figure so both plans
render identical copy.

## R11 (Important, Task 3) — the chip pattern being matched is single-select

`components/RolesTable.tsx:201-215` maps one exclusive `statusFilter`. "Match it"
is right about styling and wrong about mechanism — this plan needs two independent
booleans. An implementer following it literally may fold compensation into
`statusFilter`. Say explicitly: reuse the chip className, add
`const [meetsOnly, setMeetsOnly] = useState(false)` and
`const [hideNoRange, setHideNoRange] = useState(false)`, and **add `meetsOnly`,
`hideNoRange`, and `compFloor` to the `filtered` useMemo dependency array**
(`RolesTable.tsx:121`) — omitting them is a stale-filter bug.

## R12 (Important, Task 1) — Step 5 is unexecutable in the worktree

"Add a temporary script printing output for all 21 production strings" needs
`DATABASE_URL`, which is absent by design. Mark it `SKIPPED — requires
DATABASE_URL` and move the 21-string check to the live pass, matching how the
prerequisite handles schema application. The plan supplies only 6 of the 21.

## R13 (Important) — `fit_summary` is both input and output

`rescoreAll` writes `fit_summary: scored.rationale` while the prompt reads
`Summary: ${opts.fit_summary}`. Rescore twice and the model is summarizing its own
previous rationale rather than the posting. Stop overwriting it on rescore.

## R14 (Minor, verified)

- `saveCompFloor` accepts `0` and non-integers; a floor of `0` then shows a
  "Meets minimum" toggle that does nothing. Use `!Number.isInteger(n) || n < 1`.
- `console.warn` in `salaryBucketFor` fires once per row per recompute — on every
  keystroke in the search box. Hoist behind a module-level `Set` of warned strings.
- Task 1's Interfaces block omits `baseMaxFor`, which Task 3 consumes. Task 5's
  Files list omits `CLAUDE.md` though Step 3 edits it.
- Task 3 Step 7 stages `app/roles`, which needs no change unless R3's preferred
  fix is taken — in which case it does.
- Verification item "setting a floor hides below-floor roles" is wrong: both
  toggles default off, so setting a floor hides nothing until one is enabled.
- Comparing on `max` means `$100,000 - $200,000` meets a $200,000 floor. That is
  spec-compliant but surprising; it deserves the justifying comment.

## R15 — tests that pass against a broken implementation

- `"ignores a bare year"` asserts `.not.toBe("base")`, which passes for `absent`,
  `unparseable`, **and** `ote`. Assert the exact object.
- `"every real production string is handled"` only checks `kind !== "unparseable"`
  — it passes for a parser returning `{kind:"base",min:0,max:0}` for everything.
  And `expect(REAL.length).toBe(6)` restates a literal two lines above it. Make it
  table-driven with expected values, or delete it.
- `"meets exactly at the floor"` tests `max === floor` with `min` $50k below. No
  test covers `min === max === floor`; add `job("$200,000")` at floor 200000.

---

### Task 1: The salary parser

**Files:**
- Create: `lib/salary.ts`
- Create: `lib/salary.test.ts`

**Interfaces:**
- Produces: `type ParsedSalary`, `parseSalaryRange(raw)`.
- Consumed by: Tasks 2, 3, and 4.

**These are the real strings from the production database.** Five of the 21 rows carrying a salary are not the simple `$X - $Y` shape. A parser tested only against the simple shape passes its tests and fails a quarter of the actual data.

```
$141,400 - $203,800
$280,000 - $325,000 (base); $305,000 - $365,000 OTE
$138,945 - $165,000 (Denver); $168,420 - $200,000 (SF/NYC)
$165,000 - $175,000 base + annual bonus
$300,000 - $340,000 OTE
$150,000
```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test } from "vitest";
import { parseSalaryRange } from "./salary";

describe("parseSalaryRange", () => {
  test("parses the simple range", () => {
    expect(parseSalaryRange("$141,400 - $203,800")).toEqual({
      kind: "base",
      min: 141400,
      max: 203800,
    });
  });

  test("prefers the labeled base range over the OTE range", () => {
    // The naive "highest max" rule picks $365,000 OTE here. In GTM roles OTE
    // bundles commission and overstates base by 20-40%, so a minimum-BASE
    // floor built on that rule silently passes roles whose base is under it.
    const r = parseSalaryRange("$280,000 - $325,000 (base); $305,000 - $365,000 OTE");
    expect(r).toEqual({ kind: "base", min: 280000, max: 325000 });
  });

  test("takes the first range when several are location-scoped and none is labeled base", () => {
    const r = parseSalaryRange("$138,945 - $165,000 (Denver); $168,420 - $200,000 (SF/NYC)");
    expect(r).toEqual({ kind: "base", min: 138945, max: 165000 });
  });

  test("handles a base range with trailing prose", () => {
    expect(parseSalaryRange("$165,000 - $175,000 base + annual bonus")).toEqual({
      kind: "base",
      min: 165000,
      max: 175000,
    });
  });

  test("marks an OTE-only figure as OTE, not base", () => {
    expect(parseSalaryRange("$300,000 - $340,000 OTE")).toEqual({
      kind: "ote",
      min: 300000,
      max: 340000,
    });
  });

  test("handles a bare single value as a range of one point", () => {
    // Treating this as unparseable would tag a perfectly good $150k role as
    // "no range listed".
    expect(parseSalaryRange("$150,000")).toEqual({
      kind: "base",
      min: 150000,
      max: 150000,
    });
  });

  test("distinguishes empty input from unparseable input", () => {
    expect(parseSalaryRange("")).toEqual({ kind: "absent" });
    expect(parseSalaryRange(null)).toEqual({ kind: "absent" });
    expect(parseSalaryRange("   ")).toEqual({ kind: "absent" });
    expect(parseSalaryRange("Competitive salary DOE")).toEqual({
      kind: "unparseable",
      raw: "Competitive salary DOE",
    });
  });

  test("ignores a bare year that would otherwise look like a number", () => {
    expect(parseSalaryRange("Posted 2026").kind).not.toBe("base");
  });

  test("every real production string is handled without throwing", () => {
    const REAL = [
      "$141,400 - $203,800",
      "$280,000 - $325,000 (base); $305,000 - $365,000 OTE",
      "$138,945 - $165,000 (Denver); $168,420 - $200,000 (SF/NYC)",
      "$165,000 - $175,000 base + annual bonus",
      "$300,000 - $340,000 OTE",
      "$150,000",
    ];
    expect(REAL.length).toBe(6);
    for (const raw of REAL) {
      const r = parseSalaryRange(raw);
      expect(r.kind).not.toBe("unparseable");
    }
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npm test -- salary`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/salary.ts`**

```ts
export type ParsedSalary =
  | { kind: "base"; min: number; max: number }
  | { kind: "ote"; min: number; max: number }
  | { kind: "absent" }
  | { kind: "unparseable"; raw: string };

// A dollar figure with optional thousands separators. The $ is required: it is
// what separates a salary from a year, a headcount, or a street number.
const MONEY = /\$\s?(\d{1,3}(?:,\d{3})+|\d{4,})/g;

interface Segment {
  text: string;
  numbers: number[];
}

function segments(raw: string): Segment[] {
  // Employers separate multiple ranges with a semicolon far more consistently
  // than with anything else; splitting on it is what lets the base/OTE and the
  // Denver/SF strings be told apart rather than mashed into one number soup.
  return raw
    .split(";")
    .map((text) => {
      const numbers = Array.from(text.matchAll(MONEY)).map((m) =>
        Number(m[1].replace(/,/g, ""))
      );
      return { text, numbers };
    })
    .filter((s) => s.numbers.length > 0);
}

const OTE = /\bOTE\b|on[- ]target/i;
const BASE = /\bbase\b/i;

/**
 * Parses a posting's salary string into a comparable range.
 *
 * Precedence is deliberate: an explicitly-labeled base segment wins, then the
 * first unlabeled segment, and an OTE-only string is reported as OTE rather
 * than silently compared against a base floor.
 *
 * Returns four distinct outcomes rather than a nullable range, because
 * "the employer published nothing" and "we captured text we could not read"
 * are different facts — the second is a parser bug that would otherwise never
 * surface.
 */
export function parseSalaryRange(raw: string | null | undefined): ParsedSalary {
  if (!raw || !raw.trim()) return { kind: "absent" };

  const parts = segments(raw);
  if (parts.length === 0) return { kind: "unparseable", raw };

  const labeledBase = parts.find((p) => BASE.test(p.text) && !OTE.test(p.text));
  const nonOte = parts.find((p) => !OTE.test(p.text));
  const chosen = labeledBase ?? nonOte ?? parts[0];
  const kind: "base" | "ote" = chosen === nonOte || chosen === labeledBase ? "base" : "ote";

  const nums = chosen.numbers;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  return { kind, min, max };
}

/** The figure a minimum-base floor is compared against. OTE never qualifies. */
export function baseMaxFor(parsed: ParsedSalary): number | null {
  return parsed.kind === "base" ? parsed.max : null;
}
```

- [ ] **Step 4: Run and iterate until they pass**

Run: `npm test -- salary`
Expected: PASS, 9 tests. The `kind` derivation above is the subtle part — if `nonOte` is undefined and `labeledBase` is undefined, `chosen` is `parts[0]` and the ternary must yield `"ote"`. Verify that branch explicitly rather than assuming.

- [ ] **Step 5: Verify against every real row — reported, not asserted**

Add a temporary script printing `parseSalaryRange` output for all 21 production strings, run it, paste the output into your report, and delete the script. Any row landing on `unparseable` is a finding to report, not something to silence by loosening a test.

- [ ] **Step 6: Verify the build**

Run: `npm run build && npm test`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add lib/salary.ts lib/salary.test.ts
git commit -m "feat: parse posting salary strings, preferring base over OTE"
```

---

### Task 2: The floor setting

**Files:**
- Modify: `lib/settings-store.ts` (confirm `compFloor` key exists)
- Modify: `app/actions/settings.ts`
- Modify: `components/Settings.tsx`

**Interfaces:**
- Consumes: `SETTING_KEYS`, `writeSetting`, `deleteSetting` from the criteria plan's Task 1; `SettingsView` from its Task 6.
- Produces: `saveCompFloor(n)`, and `compFloor` on `SettingsView`.

- [ ] **Step 1: Extend `SettingsView` and `getSettings`**

Add `compFloor: number | null` to the interface, read it from the rows alongside `ceiling`, using `SETTING_KEYS.compFloor`.

- [ ] **Step 2: Add `saveCompFloor`**

```ts
export async function saveCompFloor(n: number | null): Promise<{ error?: string }> {
  if (n !== null && (!Number.isFinite(n) || n < 0)) {
    return { error: "The minimum base must be a positive number, or off." };
  }
  const { error } =
    n === null
      ? await deleteSetting(SETTING_KEYS.compFloor)
      : await writeSetting(SETTING_KEYS.compFloor, n);
  if (error) return { error: `Could not save the minimum base — ${error}` };

  // No cache clearing: compensation affects display and scoring, never query
  // construction. It does make existing scores stale — see Task 4.
  return {};
}
```

- [ ] **Step 3: Add the section to `components/Settings.tsx`**

A "Minimum base compensation" section: a number input with an explicit off state, its own Save, and one line of copy stating plainly that it filters `/roles` and feeds fit scoring but never prevents a role from being saved.

After a successful save, reuse the same rescore prompt the fit brain uses — the floor is a scoring input, so editing it makes scores stale in exactly the same way.

- [ ] **Step 4: Verify the build**

Run: `npm run build && npm test`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add app/actions/settings.ts components/Settings.tsx lib/settings-store.ts
git commit -m "feat: add minimum base compensation setting"
```

---

### Task 3: `/roles` filters

**Files:**
- Create: `lib/salary-filter.ts`
- Create: `lib/salary-filter.test.ts`
- Modify: `components/RolesTable.tsx`
- Modify: `app/roles/page.tsx` (or wherever `RolesTable` receives its data — read it first)

**Interfaces:**
- Consumes: `parseSalaryRange`, `baseMaxFor` (Task 1); `compFloor` (Task 2).
- Produces: `salaryBucketFor(job, floor)` returning `"meets" | "below" | "no-range" | "unreadable"`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test } from "vitest";
import { salaryBucketFor } from "./salary-filter";

const job = (salary_range: string | null) => ({ salary_range });

describe("salaryBucketFor", () => {
  test("meets when the base max clears the floor", () => {
    expect(salaryBucketFor(job("$180,000 - $220,000"), 200000)).toBe("meets");
  });

  test("below when the base max is under the floor", () => {
    expect(salaryBucketFor(job("$120,000 - $150,000"), 200000)).toBe("below");
  });

  test("meets exactly at the floor", () => {
    expect(salaryBucketFor(job("$150,000 - $200,000"), 200000)).toBe("meets");
  });

  test("no-range when the posting listed nothing", () => {
    expect(salaryBucketFor(job(null), 200000)).toBe("no-range");
    expect(salaryBucketFor(job(""), 200000)).toBe("no-range");
  });

  test("unreadable is distinct from no-range", () => {
    expect(salaryBucketFor(job("Competitive DOE"), 200000)).toBe("unreadable");
  });

  test("an OTE-only figure never counts as meeting a base floor", () => {
    expect(salaryBucketFor(job("$300,000 - $340,000 OTE"), 200000)).not.toBe("meets");
  });

  test("with no floor set, anything with a readable range meets", () => {
    expect(salaryBucketFor(job("$90,000 - $95,000"), null)).toBe("meets");
    expect(salaryBucketFor(job(null), null)).toBe("no-range");
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npm test -- salary-filter`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/salary-filter.ts`**

```ts
import { baseMaxFor, parseSalaryRange } from "@/lib/salary";

export type SalaryBucket = "meets" | "below" | "no-range" | "unreadable";

/**
 * Which compensation bucket a job falls into for display filtering.
 *
 * "no-range" and "unreadable" are separate on purpose: the first is the
 * employer publishing nothing, the second is a parser gap. Collapsing them
 * would hide the parser gap forever behind a UI that looks correct.
 *
 * An OTE-only figure is never "meets": OTE bundles commission, so comparing it
 * to a base floor overstates the offer.
 */
export function salaryBucketFor(
  job: { salary_range: string | null },
  floor: number | null
): SalaryBucket {
  const parsed = parseSalaryRange(job.salary_range);
  if (parsed.kind === "absent") return "no-range";
  if (parsed.kind === "unparseable") {
    console.warn(`salary-filter: could not parse "${parsed.raw}"`);
    return "unreadable";
  }
  const base = baseMaxFor(parsed);
  if (base === null) return "below"; // OTE-only: known, but not a base figure
  if (floor === null) return "meets";
  return base >= floor ? "meets" : "below";
}
```

- [ ] **Step 4: Run and verify they pass**

Run: `npm test -- salary-filter`
Expected: PASS, 7 tests.

- [ ] **Step 5: Add the two controls to `components/RolesTable.tsx`**

Read the file first — it already has a constant-driven filter-chip pattern for statuses. Match it.

Two **independent** toggles, because "pays too little" and "didn't tell me" are different facts and 48% of the table is the second one:

1. **Meets minimum** — hides `below`
2. **No range listed** — hides `no-range` and `unreadable`

Both default to **off** (nothing hidden), so the table looks exactly as it does today until the user opts in. Show a small tag on rows in the `no-range` bucket. If a floor is not set, hide the "Meets minimum" toggle entirely rather than showing a control that does nothing.

- [ ] **Step 6: Verify the build**

Run: `npm run build && npm test`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add lib/salary-filter.ts lib/salary-filter.test.ts components/RolesTable.tsx app/roles
git commit -m "feat: filter roles by compensation on display"
```

---

### Task 4: Compensation feeds fit scoring

**Files:**
- Modify: `app/actions/parse-role.ts`
- Modify: `lib/ingest-roles.ts`
- Modify: `app/actions/settings.ts`

**Interfaces:**
- Consumes: `scoreFit({ ..., fitBrain })` from the criteria plan's Task 3.
- Produces: `scoreFit` additionally accepting `salary_range` and `compFloor`.

`scoreFit` currently never receives compensation at all — every fit score in the table today was computed with zero compensation input.

- [ ] **Step 1: Extend the `scoreFit` signature**

Add `salary_range: string` and `compFloor: number | null` to `opts`. In the prompt, add the posting's salary to the ROLE block, and when `compFloor` is set, append one line to the candidate block:

```ts
const floorLine = opts.compFloor
  ? `\n- Targets roles paying at least $${opts.compFloor.toLocaleString()} base. Below that is a weaker fit unless the equity or building opportunity is exceptional.`
  : "";
```

Append `floorLine` to the fit brain in the prompt rather than mutating the stored brain — the floor is its own setting and must stay separately editable.

- [ ] **Step 2: Pass it through `ingestRoles`**

`lib/ingest-roles.ts` already has `role.salary_range`. Add `compFloor` to `IngestOptions` alongside the `criteria` the prerequisite plan added, and pass both into `scoreFit`. Update the three `ingestRoles` callers to load the floor once and pass it — do not read the setting inside `ingestRoles`.

- [ ] **Step 3: Pass it through `rescoreAll`**

In `app/actions/settings.ts`, `rescoreAll` must select `salary_range` alongside the other columns and pass it plus the current floor into `scoreFit`. Without this, a rescore would recompute every score *without* compensation and silently undo this task.

- [ ] **Step 4: Verify the build**

Run: `npm run build && npm test`
Expected: clean. The typechecker names every call site you missed.

- [ ] **Step 5: Commit**

```bash
git add app/actions/parse-role.ts lib/ingest-roles.ts app/actions/settings.ts
git commit -m "feat: fit scoring receives posting salary and the base floor"
```

---

### Task 5: The day-one rescore prompt

**Files:**
- Modify: `components/Settings.tsx`

**Interfaces:**
- Consumes: `scoredJobCount` from `getSettings`, `rescoreAll` — both from the criteria plan's Task 6.

Shipping Task 4 makes **every existing score stale**, because `scoreFit` gained an input — not on the user's first edit. The prompt must fire once after deploy, not only after an edit.

- [ ] **Step 1: Show the prompt on load when scores predate compensation**

On mount, when `scoredJobCount > 0`, show the same dismissible prompt used for a fit-brain save, worded for this case:

> N roles were scored before compensation was part of fit scoring. Rescore them for about $X?

Dismissal is per-session; it reappears on the next load until the user rescores. There is no version column by design, so the prompt cannot know for certain that a given row predates the change — the wording must therefore not claim more than it knows. Do not add a column to make it exact; that was explicitly ruled out of scope.

- [ ] **Step 2: Verify the build**

Run: `npm run build && npm test`
Expected: clean.

- [ ] **Step 3: Update `CLAUDE.md`**

Add compensation to the architecture notes: `salary_range` parses at read time via `lib/salary.ts` (base preferred over OTE), the floor lives in `app_settings`, `/roles` filters on display only, and `scoreFit` receives both. Keep the terse voice; never write `npm run lint`.

- [ ] **Step 4: Commit**

```bash
git add components/Settings.tsx CLAUDE.md
git commit -m "feat: offer a rescore after compensation joins fit scoring"
```

---

## Verification checklist

- [ ] `npm run build && npm test` is clean.
- [ ] All 21 production salary strings parse without landing on `unparseable`.
- [ ] `$280,000 - $325,000 (base); $305,000 - $365,000 OTE` parses to base 280,000–325,000 — not the OTE figures.
- [ ] `$150,000` parses rather than showing as "no range listed".
- [ ] Setting a floor hides below-floor roles from `/roles` and hides nothing else.
- [ ] The two toggles are independent; both default to off and the table initially looks unchanged.
- [ ] With no floor set, the "Meets minimum" toggle is not shown.
- [ ] A newly ingested role's fit score reflects the floor.
- [ ] Rescoring after setting a floor changes scores on below-floor roles.
- [ ] No job row is ever dropped or hidden at ingest because of compensation.
