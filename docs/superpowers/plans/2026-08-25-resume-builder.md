# Résumé Builder (Tailoring Pipeline) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire up the already-ported résumé tailoring engine (`lib/resume-render/render.js`, `lib/resume-render/content/{resume,themes}.json`, `components/resume/ResumeDocument.tsx`) into a real, gated `/resume` route: a "Tailor resume" action per tracked job in `/roles`, a `tailored_resumes` table storing the derived themes + bullet selection, and a page that renders the result with print export.

**Architecture:** One new Postgres table (`tailored_resumes`, tenant-scoped, RLS-protected) stores `{ themes, selection }` per `(tenant, job)`. `app/actions/resume.ts` derives themes from a job's stored fields via one small Claude call, then calls the vendored `selectBullets()` (pure JS, no model call) to pick bullets from the pre-approved pool in `content/resume.json`, and upserts the result. `app/resume/page.tsx` renders it via the already-built `ResumeDocument` component. Everything is gated on `actor.isAdmin`, reusing the existing admin primitive — no new identity mechanism.

**Tech Stack:** Next.js 14 App Router Server Actions, Postgres (`pg`, this repo's `lib/supabase.ts` query builder), Anthropic API via `lib/model-call.ts`, vitest.

**Spec:** `docs/superpowers/specs/2026-08-24-resume-builder-design.md` (revision 4) — read it first. This plan implements everything in it except the curation/voice subsystem, which is `docs/superpowers/specs/2026-08-25-resume-curation-design.md` and gets its own follow-up plan once this one ships (it depends on `app/actions/resume.ts` and the real `/resume` route existing).

## Global Constraints

- Gate every new page and action on `actor.isAdmin` (reusing the existing primitive) — never a new env-var/email-comparison check.
- Every exported server action must refuse a session-less call — `app/actions/auth-required.test.ts` asserts this automatically for any new file under `app/actions/`.
- `tailored_resumes` needs an explicit `grant` (not just `003_rls.sql`'s default privileges) and must be added to `TENANT_TABLES` in `lib/supabase.ts` by hand — its guard test's regex won't catch a table whose `tenant_id` is declared inline.
- The theme-derivation model call must go through `withBudget()` (`lib/metered.ts`) — never a bare `callStructured()`/`complete()` call, or budget enforcement and usage recording are silently bypassed.
- Never modify `lib/resume-render/render.js`, `content/resume.json`, or `content/themes.json` — they're vendored, byte-verified content from the Claude Design source. This plan only writes new code around them.
- Migrations ship as new numbered files in `db/migrations/`, run through `db/migrate.mjs` — never edited into `db/schema.sql`, which is stale relative to production.

---

## File Structure

- Create: `db/migrations/015_tailored_resumes.sql` — the new table, RLS, grant.
- Create: `lib/resume-prompt.ts` — pure builder for the theme-derivation prompt.
- Create: `lib/resume-prompt.test.ts` — fixture test for the builder.
- Create: `lib/__fixtures__/resume-prompt-inputs.ts` — the fixed job/vocabulary inputs the checked-in fixtures are rendered from.
- Create: `lib/__fixtures__/resume-prompt.full.txt` — rendered fixture, every job field populated.
- Create: `lib/__fixtures__/resume-prompt.sparse.txt` — rendered fixture, only the two non-nullable job fields populated.
- Create: `app/actions/resume.ts` — `requireResumeAdmin`, `tailorResumeForJob`, `getTailoredResume`.
- Create: `app/actions/resume.test.ts` — admin-gate refusal test (the one invariant `auth-required.test.ts` can't cover on its own).
- Create: `app/resume/page.tsx` — the real, gated route.
- Create: `components/resume/TailorPanel.tsx` — client component: "Tailor for this job" / "Regenerate" buttons, calls the actions, renders `ResumeDocument`.
- Modify: `components/RolesTable.tsx` — add a "Tailor resume" link per row, admin-gated.
- Modify: `app/roles/page.tsx` — thread `isAdmin` down to `RolesTable`.
- Modify: `lib/supabase.ts` — add `"tailored_resumes"` to `TENANT_TABLES`.
- Delete: `app/resume-preview/page.tsx`, `lib/__fixtures__/resume-preview-sample.ts` — the temporary verification route and its fixture, superseded by the real route this plan builds.

---

### Task 1: `tailored_resumes` migration

**Files:**
- Create: `db/migrations/015_tailored_resumes.sql`
- Modify: `lib/supabase.ts:127-138`
- Test: `lib/supabase.test.ts` (existing `TENANT_TABLES` guard — no new test file, just needs to keep passing with the new entry)

**Interfaces:**
- Produces: a `tailored_resumes` table (`id uuid`, `tenant_id uuid`, `job_id uuid`, `content jsonb`, `generated_at timestamptz`, `unique (tenant_id, job_id)`) that Task 3's actions read/write via `supabase.forTenant(tenantId).from("tailored_resumes")`.

- [ ] **Step 1: Write the migration file**

```sql
-- db/migrations/015_tailored_resumes.sql
-- One row per (tenant, job): the themes derived for that job and the bullet
-- selection produced from them. Regenerating overwrites via the unique
-- constraint's upsert target — see app/actions/resume.ts.
--
-- New table with tenant_id declared inline (not an ALTER TABLE retrofit),
-- so it needs the same explicit grant 004_metering.sql uses (003_rls.sql's
-- default-privileges clause is not relied on alone) and a manual addition
-- to TENANT_TABLES in lib/supabase.ts (see that file's comment on why the
-- guard test's regex can't catch this pattern).

create table if not exists tailored_resumes (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references users(id) on delete cascade,
  job_id       uuid not null references jobs(id) on delete cascade,
  content      jsonb not null,
  generated_at timestamptz not null default now(),
  unique (tenant_id, job_id)
);

create index if not exists tailored_resumes_tenant_idx
  on tailored_resumes (tenant_id);

alter table tailored_resumes enable row level security;
alter table tailored_resumes force row level security;

create policy tenant_isolation on tailored_resumes
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

grant select, insert, update, delete on tailored_resumes to app_rw;
```

- [ ] **Step 2: Dry-run the migration locally**

Run: `node db/migrate.mjs --dry`
Expected: output lists `015_tailored_resumes.sql` as pending, no errors parsing the file. (This only validates the file is well-formed SQL the runner can see — it does not touch a database. Actually applying it against Railway Postgres happens in Task 6's deploy step, not here.)

- [ ] **Step 3: Add `tailored_resumes` to `TENANT_TABLES`**

In `lib/supabase.ts`, find:

```ts
export const TENANT_TABLES = [
  "jobs",
  "watchlist",
  "app_settings",
  // Added by migration 002. These look like world caches and are not: their
  // contents are produced by prompts built from ONE tenant's criteria, and their
  // keys never contained those criteria.
  "discovered_roles",
  "discovered_startups",
  "role_searches",
  "crawl_runs",
] as const;
```

Change to:

```ts
export const TENANT_TABLES = [
  "jobs",
  "watchlist",
  "app_settings",
  // Added by migration 002. These look like world caches and are not: their
  // contents are produced by prompts built from ONE tenant's criteria, and their
  // keys never contained those criteria.
  "discovered_roles",
  "discovered_startups",
  "role_searches",
  "crawl_runs",
  // Added by migration 015. tenant_id is declared inline in CREATE TABLE,
  // not via ALTER TABLE ... ADD COLUMN, so it is invisible to
  // lib/supabase.test.ts's retrofit-pattern regex — added here by hand.
  "tailored_resumes",
] as const;
```

- [ ] **Step 4: Run the existing test suite to confirm nothing broke**

Run: `npm test -- lib/supabase.test.ts`
Expected: PASS. This confirms the `TENANT_TABLES` list is still internally consistent (no duplicate, matches whatever shape that test checks) — it does not and cannot verify RLS against a live database; that's Task 6.

- [ ] **Step 5: Commit**

```bash
git add db/migrations/015_tailored_resumes.sql lib/supabase.ts
git commit -m "feat: add tailored_resumes table with RLS and explicit grant"
```

---

### Task 2: Theme-derivation prompt builder

**Files:**
- Create: `lib/resume-prompt.ts`
- Create: `lib/resume-prompt.test.ts`
- Create: `lib/__fixtures__/resume-prompt-inputs.ts`
- Create: `lib/__fixtures__/resume-prompt.full.txt`
- Create: `lib/__fixtures__/resume-prompt.sparse.txt`

**Interfaces:**
- Consumes: `ThemeVocabulary` type from `@/lib/resume-render/render` (already committed — `{ themes: ThemeDefinition[]; derivation: {...}; knownGaps: {...}; evidenceNote: string }`, `ThemeDefinition = { id, label, covers, jdSignals, evidence }`).
- Produces: `JobSummaryFields` type and `buildThemePrompt(job: JobSummaryFields, vocabulary: ThemeVocabulary): { system: string; prompt: string }` — Task 3 calls this directly.

- [ ] **Step 1: Write the fixture inputs**

```ts
// lib/__fixtures__/resume-prompt-inputs.ts
//
// Fixed inputs the checked-in resume-prompt.*.txt fixtures are rendered
// from. Every populated field is distinct and non-empty, the same
// discipline lib/__fixtures__/fit-prompt-inputs.ts uses, so a builder that
// renders one value where another belongs fails rather than coincidentally
// matching.
import type { ThemeVocabulary } from "@/lib/resume-render/render";
import type { JobSummaryFields } from "@/lib/resume-prompt";

export const FIXTURE_VOCABULARY: ThemeVocabulary = {
  themes: [
    {
      id: "ops",
      label: "Revenue / marketing operations",
      covers: "process design, campaign and lead operations",
      jdSignals: ["marketing operations", "RevOps", "process design"],
      evidence: "",
    },
    {
      id: "systems",
      label: "Building — A.I. and automation",
      covers: "agentic workflows and internal tools",
      jdSignals: ["AI", "agent", "automation", "build"],
      evidence: "",
    },
  ],
  derivation: { method: "fixture", examples: [] },
  knownGaps: { note: "fixture", absent: [] },
  evidenceNote: "fixture",
};

export const FIXTURE_JOB_FULL: JobSummaryFields = {
  roleTitle: "Director of Revenue Operations",
  company: "Northwind Robotics",
  keySkills: "Salesforce, Marketo, Workato",
  fitSummary: "Strong ops leader with hands-on automation experience.",
  seniority: "Director",
  department: "Revenue Operations",
  salaryRange: "$180K–$220K",
  companyDescription: "Series C industrial robotics company.",
};

export const FIXTURE_JOB_SPARSE: JobSummaryFields = {
  roleTitle: "Director of Revenue Operations",
  company: "Northwind Robotics",
  keySkills: null,
  fitSummary: null,
  seniority: null,
  department: null,
  salaryRange: null,
  companyDescription: null,
};
```

- [ ] **Step 2: Write the failing test (structure first, fixtures pinned after Step 4)**

```ts
// lib/resume-prompt.test.ts
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildThemePrompt } from "./resume-prompt";
import {
  FIXTURE_JOB_FULL,
  FIXTURE_JOB_SPARSE,
  FIXTURE_VOCABULARY,
} from "./__fixtures__/resume-prompt-inputs";

function fixture(name: string): string {
  return readFileSync(path.join(__dirname, "__fixtures__", name), "utf8");
}

describe("buildThemePrompt", () => {
  test("every job field populated renders byte-identically to the checked-in fixture", () => {
    const { prompt } = buildThemePrompt(FIXTURE_JOB_FULL, FIXTURE_VOCABULARY);
    expect(prompt).toBe(fixture("resume-prompt.full.txt"));
  });

  test("only the two non-nullable fields populated omits every optional block", () => {
    const { prompt } = buildThemePrompt(FIXTURE_JOB_SPARSE, FIXTURE_VOCABULARY);
    expect(prompt).toBe(fixture("resume-prompt.sparse.txt"));
    expect(prompt).not.toContain("Key skills:");
    expect(prompt).not.toContain("Seniority:");
    expect(prompt).not.toContain("Department:");
    expect(prompt).not.toContain("Salary range:");
    expect(prompt).not.toContain("Company description:");
    expect(prompt).not.toContain("Fit summary:");
  });

  test("lists every theme id from the vocabulary, not a hardcoded subset", () => {
    const { system } = buildThemePrompt(FIXTURE_JOB_FULL, FIXTURE_VOCABULARY);
    expect(system).toContain("ops");
    expect(system).toContain("systems");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- lib/resume-prompt.test.ts`
Expected: FAIL — `Cannot find module './resume-prompt'` (nothing implemented yet, and the fixture `.txt` files don't exist yet either).

- [ ] **Step 4: Implement the builder**

```ts
// lib/resume-prompt.ts
//
// Builds the theme-derivation prompt: given a job's stored summary fields
// and the checked-in theme vocabulary (content/themes.json), asks the model
// for an ordered list of theme ids — nothing more. The model never sees or
// produces résumé text; lib/resume-render/render.js's selectBullets() does
// the actual bullet selection from those themes, deterministically. See
// docs/superpowers/specs/2026-08-24-resume-builder-design.md, "Tailoring
// call."
import type { ThemeVocabulary } from "@/lib/resume-render/render";

export interface JobSummaryFields {
  roleTitle: string;
  company: string;
  keySkills: string | null;
  fitSummary: string | null;
  seniority: string | null;
  department: string | null;
  salaryRange: string | null;
  companyDescription: string | null;
}

/** A missing field OMITS its whole line rather than rendering an empty or
 *  null placeholder — same convention lib/fit-prompt.ts's titleScopeBlock/
 *  domainBonusBlock use. */
function optionalLine(label: string, value: string | null): string {
  if (!value) return "";
  return `\n${label}: ${value}`;
}

function vocabularyBlock(vocabulary: ThemeVocabulary): string {
  return vocabulary.themes
    .map((t) => `- ${t.id} (${t.label}): ${t.jdSignals.join(", ")}`)
    .join("\n");
}

export function buildThemePrompt(
  job: JobSummaryFields,
  vocabulary: ThemeVocabulary
): { system: string; prompt: string } {
  const system = `You classify a job posting against a fixed vocabulary of career themes. You do not write résumé content — you only pick which of the following themes this posting calls for, ranked most relevant first. Choose only from this list; never invent a theme id.

${vocabularyBlock(vocabulary)}

Respond with strict JSON: {"themes": ["<id>", "<id>", ...]}. Include only themes with real signal in the posting — omit any with no support. If nothing matches, return {"themes": []}.`;

  const prompt = `JOB POSTING
Title: ${job.roleTitle}
Company: ${job.company}${optionalLine("Seniority", job.seniority)}${optionalLine("Department", job.department)}${optionalLine("Key skills", job.keySkills)}${optionalLine("Salary range", job.salaryRange)}${optionalLine("Company description", job.companyDescription)}${optionalLine("Fit summary", job.fitSummary)}
`;

  return { system, prompt };
}
```

- [ ] **Step 5: Generate the fixtures from the real implementation**

Run:

```bash
node -e '
const { buildThemePrompt } = require("./lib/resume-prompt.ts");
' 2>&1 || true
```

That inline form won't work directly against a `.ts` file without a loader, so use vitest to print it instead — add a temporary one-off test, run it, capture stdout, then delete the temporary test:

```bash
cat > /tmp/print-fixture.test.ts <<'EOF'
import { test } from "vitest";
import { buildThemePrompt } from "../lib/resume-prompt";
import { FIXTURE_JOB_FULL, FIXTURE_JOB_SPARSE, FIXTURE_VOCABULARY } from "../lib/__fixtures__/resume-prompt-inputs";

test("print full", () => {
  console.log("=====FULL=====");
  console.log(buildThemePrompt(FIXTURE_JOB_FULL, FIXTURE_VOCABULARY).prompt);
  console.log("=====SPARSE=====");
  console.log(buildThemePrompt(FIXTURE_JOB_SPARSE, FIXTURE_VOCABULARY).prompt);
  console.log("=====END=====");
});
EOF
cp /tmp/print-fixture.test.ts lib/__print-fixture.test.ts
npx vitest run lib/__print-fixture.test.ts 2>&1 | sed -n '/=====FULL=====/,/=====END=====/p'
rm lib/__print-fixture.test.ts
```

Copy the text between `=====FULL=====` and `=====SPARSE=====` (exclusive of both markers) into `lib/__fixtures__/resume-prompt.full.txt`, and the text between `=====SPARSE=====` and `=====END=====` into `lib/__fixtures__/resume-prompt.sparse.txt`. Save both with no extra trailing newline beyond what the builder itself produces.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -- lib/resume-prompt.test.ts`
Expected: PASS, all three tests.

- [ ] **Step 7: Commit**

```bash
git add lib/resume-prompt.ts lib/resume-prompt.test.ts lib/__fixtures__/resume-prompt-inputs.ts lib/__fixtures__/resume-prompt.full.txt lib/__fixtures__/resume-prompt.sparse.txt
git commit -m "feat: add theme-derivation prompt builder with pinned fixtures"
```

---

### Task 3: `app/actions/resume.ts`

**Files:**
- Create: `app/actions/resume.ts`
- Create: `app/actions/resume.test.ts`

**Interfaces:**
- Consumes: `buildThemePrompt`/`JobSummaryFields` (Task 2); `selectBullets`, `CareerRecord`, `ThemeVocabulary`, `ResumeSelection` from `@/lib/resume-render/render`; `career` from `@/lib/resume-render/content/resume.json`; `themeVocabulary` from `@/lib/resume-render/content/themes.json`; `requireActor` from `@/lib/require-actor`; `withBudget` from `@/lib/metered`; `complete`, `parseJson` from `@/lib/model-call`; `supabase` from `@/lib/supabase`; `describeWriteFailure` from `@/lib/write-failure`.
- Produces: `tailorResumeForJob(jobId: string): Promise<{ themes: string[]; selection: ResumeSelection | null; error?: string }>`, `getTailoredResume(jobId: string): Promise<{ themes: string[]; selection: ResumeSelection | null; error?: string }>`, `getJobContext(jobId: string): Promise<{ roleTitle: string; company: string } | null>` — all three consumed by Task 4.

- [ ] **Step 1: Write the failing admin-gate test**

```ts
// app/actions/resume.test.ts
//
// Pins the one invariant auth-required.test.ts's blanket session-less-call
// check cannot catch on its own: a SESSION-HOLDING but non-admin actor must
// still be refused. Mirrors the shape lib/auth-policy.test.ts uses for this
// app's other auth invariants.
import { describe, expect, test, vi } from "vitest";

vi.mock("@/lib/require-actor", () => ({
  requireActor: async () => ({
    userId: "u1",
    tenantId: "u1",
    email: "someone@example.com",
    isAdmin: false,
  }),
}));

import { getJobContext, getTailoredResume, tailorResumeForJob } from "./resume";

describe("resume.ts refuses a non-admin actor", () => {
  test("tailorResumeForJob", async () => {
    await expect(tailorResumeForJob("11111111-1111-1111-1111-111111111111")).rejects.toThrow(
      /Not authorized/
    );
  });

  test("getTailoredResume", async () => {
    await expect(getTailoredResume("11111111-1111-1111-1111-111111111111")).rejects.toThrow(
      /Not authorized/
    );
  });

  test("getJobContext", async () => {
    await expect(getJobContext("11111111-1111-1111-1111-111111111111")).rejects.toThrow(
      /Not authorized/
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- app/actions/resume.test.ts`
Expected: FAIL — `Cannot find module './resume'`.

- [ ] **Step 3: Implement `app/actions/resume.ts`**

```ts
// app/actions/resume.ts
"use server";

import { requireActor } from "@/lib/require-actor";
import { withBudget } from "@/lib/metered";
import { complete, parseJson } from "@/lib/model-call";
import { supabase } from "@/lib/supabase";
import { describeWriteFailure } from "@/lib/write-failure";
import { buildThemePrompt, type JobSummaryFields } from "@/lib/resume-prompt";
import {
  selectBullets,
  type CareerRecord,
  type ResumeSelection,
  type ThemeVocabulary,
} from "@/lib/resume-render/render";
import career from "@/lib/resume-render/content/resume.json";
import themeVocabulary from "@/lib/resume-render/content/themes.json";

/**
 * Admin-only, checked SERVER-SIDE on every action — one shared function
 * rather than a hand-copy in each export, the exact failure mode
 * app/actions/auth-required.test.ts's own doc comment warns about ("a
 * hand-written check is one someone forgets when adding the 37th").
 * Mirrors app/actions/admin.ts's requireAdmin() exactly.
 */
async function requireResumeAdmin() {
  const actor = await requireActor();
  if (!actor.isAdmin) throw new Error("Not authorized");
  return actor;
}

interface JobRow {
  role_title: string;
  company: string;
  key_skills: string | null;
  fit_summary: string | null;
  seniority: string | null;
  department: string | null;
  salary_range: string | null;
  company_description: string | null;
}

async function loadJobForTenant(tenantId: string, jobId: string): Promise<JobRow | null> {
  const { data, error } = await supabase
    .forTenant(tenantId)
    .from("jobs")
    .select("role_title, company, key_skills, fit_summary, seniority, department, salary_range, company_description")
    .eq("id", jobId)
    .maybeSingle();
  if (error) {
    console.error("loadJobForTenant error:", error);
    return null;
  }
  return (data as JobRow | null) ?? null;
}

function toSummaryFields(job: JobRow): JobSummaryFields {
  return {
    roleTitle: job.role_title,
    company: job.company,
    keySkills: job.key_skills,
    fitSummary: job.fit_summary,
    seniority: job.seniority,
    department: job.department,
    salaryRange: job.salary_range,
    companyDescription: job.company_description,
  };
}

interface ThemeResponse {
  themes: string[];
}

async function deriveThemes(job: JobSummaryFields): Promise<string[]> {
  const { system, prompt } = buildThemePrompt(job, themeVocabulary as ThemeVocabulary);
  const raw = await complete({ system, prompt, maxTokens: 500 });
  const parsed = parseJson<ThemeResponse>(raw);
  const validIds = new Set((themeVocabulary as ThemeVocabulary).themes.map((t) => t.id));
  return Array.isArray(parsed.themes) ? parsed.themes.filter((id) => validIds.has(id)) : [];
}

export async function tailorResumeForJob(
  jobId: string
): Promise<{ themes: string[]; selection: ResumeSelection | null; error?: string }> {
  const actor = await requireResumeAdmin();

  const job = await loadJobForTenant(actor.tenantId, jobId);
  if (!job) {
    return { themes: [], selection: null, error: "Could not find that job" };
  }

  const budget = await withBudget({
    action: "tailor-resume",
    estimateCents: 1,
    isAdmin: actor.isAdmin,
    fn: () => deriveThemes(toSummaryFields(job)),
  });
  if (budget.capped) return { themes: [], selection: null, error: budget.capped };
  if (budget.error !== undefined) return { themes: [], selection: null, error: budget.error };

  const themes = budget.result!;
  const selection = selectBullets(career as CareerRecord, { themes });

  const { error } = await supabase
    .forTenant(actor.tenantId)
    .from("tailored_resumes")
    .upsert({ tenant_id: actor.tenantId, job_id: jobId, content: { themes, selection } }, { onConflict: "tenant_id,job_id" });
  const described = describeWriteFailure(error ? error.message : undefined, "save that tailored resume");
  if (described !== undefined) return { themes, selection, error: described };

  return { themes, selection };
}

export async function getTailoredResume(
  jobId: string
): Promise<{ themes: string[]; selection: ResumeSelection | null; error?: string }> {
  const actor = await requireResumeAdmin();

  const { data, error } = await supabase
    .forTenant(actor.tenantId)
    .from("tailored_resumes")
    .select("content")
    .eq("job_id", jobId)
    .maybeSingle();
  if (error) {
    console.error("getTailoredResume error:", error);
    return { themes: [], selection: null, error: error.message };
  }
  if (!data) return { themes: [], selection: null };

  const content = (data as { content: { themes: string[]; selection: ResumeSelection } }).content;
  return { themes: content.themes, selection: content.selection };
}

/**
 * Just enough of a tracked job to show as context on /resume?jobId=... —
 * the base spec requires the target job's title and company be shown there.
 * Reuses loadJobForTenant rather than a second query shape.
 */
export async function getJobContext(
  jobId: string
): Promise<{ roleTitle: string; company: string } | null> {
  const actor = await requireResumeAdmin();
  const job = await loadJobForTenant(actor.tenantId, jobId);
  if (!job) return null;
  return { roleTitle: job.role_title, company: job.company };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- app/actions/resume.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite to confirm `auth-required.test.ts` picks up the new file automatically**

Run: `npm test -- app/actions/auth-required.test.ts`
Expected: PASS, and the output includes a test named `resume.ts` (confirms the file-globbing in that test found the new module and both exports refused a session-less call).

- [ ] **Step 6: Commit**

```bash
git add app/actions/resume.ts app/actions/resume.test.ts
git commit -m "feat: add tailorResumeForJob/getTailoredResume server actions"
```

---

### Task 4: The real `/resume` route

**Files:**
- Create: `app/resume/page.tsx`
- Create: `components/resume/TailorPanel.tsx`
- Delete: `app/resume-preview/page.tsx`
- Delete: `lib/__fixtures__/resume-preview-sample.ts`

**Interfaces:**
- Consumes: `tailorResumeForJob`, `getTailoredResume`, `getJobContext` (Task 3); `ResumeDocument` (`components/resume/ResumeDocument.tsx`, already committed — takes `{ career: CareerRecord; selection?: ResumeSelection }`); `requireActorPage` (`@/lib/require-actor`).

- [ ] **Step 1: Delete the temporary preview route and its fixture**

```bash
git rm app/resume-preview/page.tsx lib/__fixtures__/resume-preview-sample.ts
```

- [ ] **Step 2: Write `TailorPanel`, the client component that calls the actions**

```tsx
// components/resume/TailorPanel.tsx
"use client";

import { useState, useTransition } from "react";
import ResumeDocument from "@/components/resume/ResumeDocument";
import { getTailoredResume, tailorResumeForJob } from "@/app/actions/resume";
import type { CareerRecord, ResumeSelection } from "@/lib/resume-render/render";

export default function TailorPanel({
  career,
  jobId,
  initialSelection,
}: {
  career: CareerRecord;
  jobId: string;
  initialSelection: ResumeSelection | null;
}) {
  const [selection, setSelection] = useState(initialSelection);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function tailor() {
    setError(null);
    startTransition(async () => {
      const res = await tailorResumeForJob(jobId);
      if (res.error) setError(res.error);
      else setSelection(res.selection);
    });
  }

  function regenerate() {
    if (!window.confirm("Regenerate this tailored resume? The current version will be replaced.")) return;
    tailor();
  }

  if (!selection) {
    return (
      <div className="flex flex-col items-start gap-3">
        {error && <p className="text-sm text-[#92400E]">{error}</p>}
        <button
          onClick={tailor}
          disabled={isPending}
          className="rounded border border-slate px-3 py-1.5 text-sm hover:border-ink disabled:opacity-50"
        >
          {isPending ? "Tailoring…" : "Tailor for this job"}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {error && <p className="text-sm text-[#92400E]">{error}</p>}
      <div className="flex items-center gap-3">
        <button
          onClick={() => window.print()}
          className="rounded border border-slate px-3 py-1.5 text-sm hover:border-ink"
        >
          Print / Export PDF
        </button>
        <button
          onClick={regenerate}
          disabled={isPending}
          className="rounded border border-slate px-3 py-1.5 text-sm hover:border-ink disabled:opacity-50"
        >
          {isPending ? "Regenerating…" : "Regenerate"}
        </button>
      </div>
      <ResumeDocument career={career} selection={selection} />
    </div>
  );
}
```

That refetch-on-load `getTailoredResume` call itself belongs in the server component below — `TailorPanel` just takes `initialSelection` as a prop so the page's server component owns the tenant-scoped read, and `TailorPanel` only calls actions in response to a click. `useTransition` (not a bare `async` `onClick`) is used so `isPending` disables the buttons during the request — the same reason `RolesTable.tsx`'s own async handlers exist.

- [ ] **Step 3: Write the page**

```tsx
// app/resume/page.tsx
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireActorPage } from "@/lib/require-actor";
import { getJobContext, getTailoredResume } from "@/app/actions/resume";
import TailorPanel from "@/components/resume/TailorPanel";
import type { CareerRecord } from "@/lib/resume-render/render";
import career from "@/lib/resume-render/content/resume.json";

export const dynamic = "force-dynamic";

export default async function ResumePage({
  searchParams,
}: {
  searchParams: { jobId?: string };
}) {
  const actor = await requireActorPage();
  if (!actor.isAdmin) redirect("/discover");

  const jobId = searchParams.jobId;
  if (!jobId) {
    return (
      <div className="mx-auto max-w-2xl p-8">
        <h1 className="text-xl font-semibold">Résumé</h1>
        <p className="mt-2 text-sm text-ink/70">
          Tailor a résumé from a tracked role — open{" "}
          <Link href="/roles" className="underline underline-offset-2">
            Roles
          </Link>{" "}
          and click "Tailor resume" on the one you want.
        </p>
      </div>
    );
  }

  const [context, existing] = await Promise.all([getJobContext(jobId), getTailoredResume(jobId)]);

  return (
    <div className="mx-auto max-w-3xl p-8">
      <h1 className="text-xl font-semibold">Résumé</h1>
      {context ? (
        <p className="mt-1 text-sm text-ink/70">
          For {context.roleTitle} at {context.company}
        </p>
      ) : (
        <p className="mt-1 text-sm text-[#92400E]">
          That job couldn't be found — it may have been deleted.
        </p>
      )}
      <div className="mt-6">
        <TailorPanel
          career={career as CareerRecord}
          jobId={jobId}
          initialSelection={existing.selection}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Add the nav entry, admin-gated**

In `app/layout.tsx`, find where `Nav isAdmin={isAdmin}` is rendered (line ~63) and check `components/Nav.tsx`'s `TABS`/admin-tab-append logic (line ~21: `const tabs = isAdmin ? [...TABS, { label: "Accounts", href: "/admin" }] : TABS;`). Change that line to also append the Résumé tab:

```ts
const tabs = isAdmin
  ? [...TABS, { label: "Résumé", href: "/resume" }, { label: "Accounts", href: "/admin" }]
  : TABS;
```

- [ ] **Step 5: Typecheck**

Run: `npm run build`
Expected: PASS (this repo's build includes typecheck — it's the real gate, not `tsc --noEmit`, per this repo's own CLAUDE.md caveat about ES5 target differences).

- [ ] **Step 6: Commit**

```bash
git add app/resume/page.tsx components/resume/TailorPanel.tsx components/Nav.tsx
git commit -m "feat: add the real, admin-gated /resume route"
```

---

### Task 5: "Tailor resume" button on `/roles`

**Files:**
- Modify: `app/roles/page.tsx`
- Modify: `components/RolesTable.tsx:182` (component signature) and `components/RolesTable.tsx:1173-1189` (the expanded-row action-links area)

**Interfaces:**
- Consumes: nothing new — a plain `<Link>` to `/resume?jobId=<id>`.

- [ ] **Step 1: Thread `isAdmin` from the page into `RolesTable`**

In `app/roles/page.tsx`, change:

```tsx
export default async function RolesPage() {
  await requireActorPage();
  return <RolesTable compFloor={await readCompFloor()} />;
}
```

to:

```tsx
export default async function RolesPage() {
  const actor = await requireActorPage();
  return <RolesTable compFloor={await readCompFloor()} isAdmin={actor.isAdmin} />;
}
```

- [ ] **Step 2: Accept the new prop in `RolesTable`**

In `components/RolesTable.tsx:182`, change:

```tsx
export default function RolesTable({ compFloor }: { compFloor: number | null }) {
```

to:

```tsx
export default function RolesTable({
  compFloor,
  isAdmin,
}: {
  compFloor: number | null;
  isAdmin: boolean;
}) {
```

- [ ] **Step 3: Add the button to the expanded-row actions area**

At `components/RolesTable.tsx:1173-1189`, the existing block is:

```tsx
                    <div className="flex items-center gap-4">
                      {job.company_url && (
                        <a href={job.company_url} target="_blank" rel="noreferrer" className="text-sm underline underline-offset-2 hover:text-ink/60">Company site →</a>
                      )}
                      {job.job_url && (
                        <a href={job.job_url} target="_blank" rel="noreferrer" className="text-sm underline underline-offset-2 hover:text-ink/60">Job listing →</a>
                      )}
                      {job.careers_url && (
                        <a href={job.careers_url} target="_blank" rel="noreferrer" className="text-sm underline underline-offset-2 hover:text-ink/60">Careers page →</a>
                      )}
                      <button
                        onClick={() => handleDelete(job.id)}
                        className="ml-auto rounded border border-slate px-2 py-1 text-xs text-[#92400E] hover:border-[#92400E]"
                      >
                        Delete
                      </button>
                    </div>
```

Add the `Link` import at the top of the file (near the other imports) if not already present:

```tsx
import Link from "next/link";
```

Then change the block to:

```tsx
                    <div className="flex items-center gap-4">
                      {job.company_url && (
                        <a href={job.company_url} target="_blank" rel="noreferrer" className="text-sm underline underline-offset-2 hover:text-ink/60">Company site →</a>
                      )}
                      {job.job_url && (
                        <a href={job.job_url} target="_blank" rel="noreferrer" className="text-sm underline underline-offset-2 hover:text-ink/60">Job listing →</a>
                      )}
                      {job.careers_url && (
                        <a href={job.careers_url} target="_blank" rel="noreferrer" className="text-sm underline underline-offset-2 hover:text-ink/60">Careers page →</a>
                      )}
                      {isAdmin && (
                        <Link
                          href={`/resume?jobId=${job.id}`}
                          className="text-sm underline underline-offset-2 hover:text-ink/60"
                        >
                          Tailor resume →
                        </Link>
                      )}
                      <button
                        onClick={() => handleDelete(job.id)}
                        className="ml-auto rounded border border-slate px-2 py-1 text-xs text-[#92400E] hover:border-[#92400E]"
                      >
                        Delete
                      </button>
                    </div>
```

- [ ] **Step 4: Typecheck**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS, all existing tests plus the new ones from Tasks 1–3.

- [ ] **Step 6: Commit**

```bash
git add app/roles/page.tsx components/RolesTable.tsx
git commit -m "feat: add admin-gated 'Tailor resume' link to the Roles table"
```

---

### Task 6: Deploy and verify

Not a code task — an operational checklist, matching the base spec's "Deploy and rollout" section. Run through this after Tasks 1–5 are merged.

- [ ] **Step 1: Run the migration against the live database**

Follow this repo's `railway-cli` skill for the exact command shape (project `gtm-job-search`, service `web`'s Postgres). The migration itself:

```bash
railway run --service Postgres sh -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" node db/migrate.mjs'
```

Expected: `015_tailored_resumes.sql` applied, logged in `schema_migrations`.

- [ ] **Step 2: Confirm the table, RLS, and grant directly**

Connect to the live database (via the `railway-cli` skill's guidance for one-off SQL) and run:

```sql
select tablename, rowsecurity, forcerowsecurity
  from pg_tables t join pg_class c on c.relname = t.tablename
 where tablename = 'tailored_resumes';
```

Expected: `rowsecurity = true`, `forcerowsecurity = true`. Then confirm a query with `app.tenant_id` unset returns zero rows, and one with it set to a real tenant id returns only that tenant's rows — the exact check the base spec's "Deploy and rollout" section specifies.

- [ ] **Step 3: Push and verify the deployed commit**

Push to `main` (this service auto-deploys from GitHub — see this repo's CLAUDE.md "Deploy" section). Then:

```bash
railway deployment list --service web --limit 1 --json
git rev-parse main
```

Expected: the deployment's `meta.commitHash` matches `git rev-parse main`.

- [ ] **Step 4: Confirm gating end-to-end as the app owner**

Sign in as the admin account. Confirm: `/resume` renders (with and without `?jobId=`); the "Résumé" nav entry appears; the "Tailor resume →" link appears on `/roles` rows. If a second, non-admin test account is available, confirm `/resume` redirects to `/discover` and neither the nav entry nor the roles-table link appears for it.

- [ ] **Step 5: Run one real tailoring pass and confirm metering**

From `/roles`, click "Tailor resume" on a real tracked job. Confirm a résumé renders. Then check the admin budget overview (`/admin`) and confirm the call shows up there — the end-to-end proof that `withBudget()` is actually wired in, not just present in the code.

- [ ] **Step 6: Confirm regenerate upserts rather than duplicating**

Click "Regenerate" on that same job's résumé (confirm through the `window.confirm()` prompt). Then query the live database directly:

```sql
select count(*) from tailored_resumes where job_id = '<that job's uuid>';
```

Expected: `1`, with `generated_at` updated to the more recent timestamp — proof `on conflict (tenant_id, job_id) do update` (via `.upsert(..., { onConflict: "tenant_id,job_id" })` in `tailorResumeForJob`) is actually taking the update path, not silently erroring or inserting a second row.
