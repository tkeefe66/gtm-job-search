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
