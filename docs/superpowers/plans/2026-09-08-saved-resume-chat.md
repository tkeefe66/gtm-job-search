# Saved-résumé editing: reproducible rows, checkpoint-then-restore

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a saved résumé editable — reopen it into the working draft with the chat attached — without ever destroying the state it replaces.

**Architecture:** `saved_resumes` gains `content jsonb` (the `{themes, selection, overrides}` that produced the row) and `kind text` (`'save'` or `'checkpoint'`). A new `restoreSavedVersion(savedId)` action renders the current draft, writes it to the archive as a checkpoint, demotes older checkpoints to a 3-day clock, then upserts the chosen row's `content` into `tailored_resumes` and appends a marker turn to the chat thread. The existing tailor screen and chat are reused unchanged.

**Tech Stack:** Next.js 14 App Router, TypeScript, Postgres via `lib/supabase.ts`, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-08-saved-resume-chat-design.md`

## Global Constraints

- **`npm run build && npm test` is the gate.** `npm run lint` is non-functional in this repo — do not add it.
- **`tsconfig.json` declares no `target`, so the build typechecks at ES5.** A regex `/u` flag or `\p{L}` escape passes vitest and fails the build. `npx tsc --noEmit --target es2017` does NOT reproduce the gate.
- **Every raw statement against a tenant table passes the tenant id as `rawQuery`'s THIRD argument.** `runAsTenant` sets an AsyncLocalStorage value, not the Postgres GUC, and `app_rw` is `nobypassrls` — a tenant-table statement with no tenant set matches zero rows and returns no error.
- **Errors are `{ error?: string }` and the string can be EMPTY.** Detect with `describeWriteFailure(err, "…")` then branch on `!== undefined`. Never `if (res.error)`.
- **`requireResumeAdmin()` is the FIRST statement of every exported action, never inside a try** — `app/actions/auth-required.test.ts` asserts it throws.
- **Retention values live only in `lib/resume-retention.ts`.** Never retype a day count or a SQL comparison at a call site.
- Commit messages end with the two attribution lines used elsewhere in this repo.

---

### Task 1: Migration 021 — `content` and `kind`

**Files:**
- Create: `db/migrations/021_saved_resume_content.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: columns `saved_resumes.content jsonb` (nullable) and `saved_resumes.kind text not null default 'save'`.

- [ ] **Step 1: Write the migration**

```sql
-- db/migrations/021_saved_resume_content.sql
-- Makes a saved résumé REPRODUCIBLE and classifies how it was created.
--
-- `content` is the {themes, selection, overrides} that produced the row — the
-- same shape tailored_resumes.content holds. Nullable with NO default, so a row
-- written before this migration stays distinguishable from one written with an
-- empty selection; a default of '{}' would make every historical row claim to be
-- reproducible. Same reasoning as jobs.posting and saved_resumes.page_margin.
--
-- It stores the BASE selection, never the effective one. loadResumeContext
-- returns both (app/actions/resume.ts:302-312) because the merged view cannot be
-- un-merged; storing the effective selection would re-apply every override on
-- top of a selection that already has them folded in.
--
-- `kind` exists because retention now depends on the distinction (30/3 days for
-- checkpoints against 60 for deliberate saves) and the alternative — matching
-- the "Checkpoint · <date>" label — is a discriminator the user can type by
-- hand. jobs.status stores an immutable KEY with the label as presentation only,
-- for exactly this reason. The default classifies every existing row correctly
-- with no backfill.
--
-- An ALTER on an existing table inherits its RLS and its app_rw grant: migration
-- 009's column-list revoke is users-only, and a table-level grant covers columns
-- added later (012_watchlist_signal.sql and 020 both record this). So no new
-- policy and no new grant.

alter table saved_resumes add column if not exists content jsonb;
alter table saved_resumes add column if not exists kind text not null default 'save';
```

- [ ] **Step 2: Verify it is idempotent and syntactically valid**

Run against production (it is additive and the running build ignores both columns):

```bash
railway link --project e1db9a0d-c4fd-410f-aa98-75d449e961af --environment production --service Postgres
railway run node -e "const pg=require('/Users/tomkeefe/Code Apps/gtm-job-search/.claude/worktrees/resume-update/node_modules/pg/lib/index.js');const fs=require('fs');(async()=>{const c=new pg.Client({connectionString:process.env.DATABASE_PUBLIC_URL||process.env.DATABASE_URL});await c.connect();await c.query(fs.readFileSync('db/migrations/021_saved_resume_content.sql','utf8'));const r=await c.query(\"select column_name from information_schema.columns where table_name='saved_resumes' and column_name in ('content','kind')\");console.log(r.rows);await c.end();})()"
```

Expected: `[ { column_name: 'content' }, { column_name: 'kind' } ]`. Run it twice — the second run must succeed unchanged.

- [ ] **Step 3: Commit**

```bash
git add db/migrations/021_saved_resume_content.sql
git commit -m "feat: saved_resumes gains content and kind"
```

---

### Task 2: Retention tiers

**Files:**
- Modify: `lib/resume-retention.ts`
- Test: `lib/resume-retention.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `RETENTION_DAYS = 60`, `CHECKPOINT_RETENTION_DAYS = 30`, `SUPERSEDED_CHECKPOINT_DAYS = 3`, and `expiresAtFrom(now: Date, days?: number): Date` (defaulting to `RETENTION_DAYS`, so existing call sites are unchanged).

- [ ] **Step 1: Write the failing tests**

Append to `lib/resume-retention.test.ts`:

```ts
import {
  CHECKPOINT_RETENTION_DAYS,
  RETENTION_DAYS,
  SUPERSEDED_CHECKPOINT_DAYS,
  expiresAtFrom,
} from "@/lib/resume-retention";

describe("tiered retention", () => {
  const now = new Date("2026-09-08T00:00:00.000Z");
  const days = (d: Date) => Math.round((d.getTime() - now.getTime()) / 86400000);

  // Mutation this catches: expiresAtFrom ignoring its new argument and always
  // stamping RETENTION_DAYS. Every existing call site passes no argument, so a
  // test that only exercises the default cannot see it.
  it("stamps the day count it is given", () => {
    expect(days(expiresAtFrom(now, CHECKPOINT_RETENTION_DAYS))).toBe(30);
    expect(days(expiresAtFrom(now, SUPERSEDED_CHECKPOINT_DAYS))).toBe(3);
  });

  // Mutation this catches: changing the default, which would silently reprice
  // every deliberate Save in the app.
  it("defaults to the 60-day window", () => {
    expect(days(expiresAtFrom(now))).toBe(RETENTION_DAYS);
    expect(RETENTION_DAYS).toBe(60);
  });

  // Mutation this catches: tiers that are not strictly ordered. A superseded
  // checkpoint outliving the newest one would make demotion an extension.
  it("orders the three tiers", () => {
    expect(SUPERSEDED_CHECKPOINT_DAYS).toBeLessThan(CHECKPOINT_RETENTION_DAYS);
    expect(CHECKPOINT_RETENTION_DAYS).toBeLessThan(RETENTION_DAYS);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/resume-retention.test.ts`
Expected: FAIL — `CHECKPOINT_RETENTION_DAYS` is not exported.

- [ ] **Step 3: Implement**

In `lib/resume-retention.ts`, add below `RETENTION_DAYS` and replace `expiresAtFrom`:

```ts
/** The newest checkpoint for a job. Shorter than a deliberate Save because the
 *  user did not choose to keep it — the app wrote it to protect their work. */
export const CHECKPOINT_RETENTION_DAYS = 30;

/** A checkpoint that a newer one has superseded. A checkpoint's real job is
 *  "undo what I just did", which is a same-session need. */
export const SUPERSEDED_CHECKPOINT_DAYS = 3;

export function expiresAtFrom(now: Date, days: number = RETENTION_DAYS): Date {
  return new Date(now.getTime() + days * MS_PER_DAY);
}
```

Leave `EXPIRED_PREDICATE`, `LIVE_PREDICATE` and `isExpired` untouched. They compare `expires_at` against `now()` and nothing else; only the stamping learns tiers, which is what keeps the complementary-pair test meaningful.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run lib/resume-retention.test.ts`
Expected: PASS, including the pre-existing complementary-predicate tests.

- [ ] **Step 5: Commit**

```bash
git add lib/resume-retention.ts lib/resume-retention.test.ts
git commit -m "feat: retention tiers for checkpoints"
```

---

### Task 3: `savedEditAffordance`

**Files:**
- Create: `lib/saved-edit-affordance.ts`
- Test: `lib/saved-edit-affordance.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `savedEditAffordance(input: { hasContent: boolean; jobId: string | null }): SavedEditAffordance`, where `SavedEditAffordance = { kind: "restore" } | { kind: "draftOnly"; note: string } | { kind: "unavailable"; note: string }`.

- [ ] **Step 1: Write the failing test**

```ts
// lib/saved-edit-affordance.test.ts
import { describe, expect, it } from "vitest";
import { savedEditAffordance } from "@/lib/saved-edit-affordance";

describe("savedEditAffordance", () => {
  it("offers a restore when the row is reproducible and its job is alive", () => {
    expect(savedEditAffordance({ hasContent: true, jobId: "job-1" }).kind).toBe("restore");
  });

  // Mutation this catches: treating a pre-021 row as restorable. Its content is
  // null, so a restore would upsert null over the draft.
  it("offers the draft only when the row predates stored content", () => {
    const a = savedEditAffordance({ hasContent: false, jobId: "job-1" });
    expect(a.kind).toBe("draftOnly");
    expect(a.kind === "draftOnly" && a.note).toContain("may differ");
  });

  // Mutation this catches: checking hasContent BEFORE jobId. With no job there
  // is no tailored_resumes row (its job_id is NOT NULL) and no tailor screen to
  // open, so unavailable has to win. A fixture pairing a null job only with
  // absent content cannot tell the two orderings apart — this is the case that
  // discriminates, and the sibling test below is the one that would pass either
  // way.
  it("is unavailable when the job is gone even though content exists", () => {
    const a = savedEditAffordance({ hasContent: true, jobId: null });
    expect(a.kind).toBe("unavailable");
    expect(a.kind === "unavailable" && a.note).toContain("deleted");
  });

  it("is unavailable when the job is gone and there is no content", () => {
    expect(savedEditAffordance({ hasContent: false, jobId: null }).kind).toBe("unavailable");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/saved-edit-affordance.test.ts`
Expected: FAIL — cannot resolve `@/lib/saved-edit-affordance`.

- [ ] **Step 3: Implement**

```ts
// lib/saved-edit-affordance.ts
//
// What the archive screen may offer for one saved row.
//
// A pure function rather than a ternary in the component, for the reason
// signInBody (lib/auth-policy.ts:246), enrichGate (lib/enrich-scope.ts:89) and
// compRescoreOffer (lib/rescore-progress.ts:123) are: a server component's JSX
// is reachable from no test in this repo, so a branch written inline is green
// under a suite that cannot see it.

export type SavedEditAffordance =
  | { kind: "restore" }
  | { kind: "draftOnly"; note: string }
  | { kind: "unavailable"; note: string };

export function savedEditAffordance(input: {
  hasContent: boolean;
  jobId: string | null;
}): SavedEditAffordance {
  // Order matters. With no job there is no tailored_resumes row to restore into
  // (its job_id is NOT NULL) and no resume_chats thread either, so the whole
  // feature is permanently unreachable for this row — not merely the button.
  // Checking hasContent first would offer a restore that cannot run.
  if (input.jobId === null) {
    return {
      kind: "unavailable",
      note: "The tracked role this résumé came from was deleted, so it can no longer be edited.",
    };
  }
  if (!input.hasContent) {
    return {
      kind: "draftOnly",
      note: "Saved before résumés recorded how they were built, so this opens the current draft, which may differ from the document above.",
    };
  }
  return { kind: "restore" };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run lib/saved-edit-affordance.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/saved-edit-affordance.ts lib/saved-edit-affordance.test.ts
git commit -m "feat: the saved-row edit affordance as a pure decision"
```

---

### Task 4: Render a draft to HTML on the server

**Files:**
- Create: `lib/draft-render.ts`
- Test: `lib/draft-render.test.ts`

**Interfaces:**
- Consumes: `effectiveCareer` (`lib/effective-career.ts`), `effectiveDocument` (`lib/effective-document.ts`), `styleAttributeFor` (`lib/resume-design-tokens.ts`), `renderBody` (`lib/resume-render/render`).
- Produces: `renderDraftHtml(input: { career: CareerRecord; overlay: OverlayBullet[]; themes: string[]; baseSelection: ResumeSelection; overrides: ResumeOverrides }): string`.

This is the pipeline the checkpoint needs. It exists as its own module so it is
reachable from a test — `loadResumeContext` is a `"use server"` action and
`ResumeDocument` is a client component, so the composition currently lives in
two places vitest cannot execute together.

- [ ] **Step 1: Write the failing test**

```ts
// lib/draft-render.test.ts
import { describe, expect, it } from "vitest";
import { renderDraftHtml } from "@/lib/draft-render";
import { renderBody, selectBullets } from "@/lib/resume-render/render";
import type { CareerRecord } from "@/lib/resume-render/render";
import careerJson from "@/lib/resume-render/content/resume.json";

const career = careerJson as CareerRecord;
const themes = ["ops", "data"];
const base = selectBullets(career, { themes });

describe("renderDraftHtml", () => {
  // Mutation this catches: renderBody(career, baseSelection) — the literal
  // reading of "render content through renderBody", which drops every override.
  // A taper override changes which bullets survive, so the two renders differ in
  // their <li> count; without this the checkpoint would be a document the user
  // never had, and nothing else in the suite would notice.
  it("applies a taper override rather than rendering the base selection", () => {
    const withTaper = renderDraftHtml({
      career,
      overlay: [],
      themes,
      baseSelection: base,
      overrides: { selection: { taper: [2, 2, 2, 2, 2] } },
    });
    const naive = renderBody(career, base);
    expect(withTaper).not.toBe(naive);
    const count = (s: string) => (s.match(/<li>/g) || []).length;
    expect(count(withTaper)).toBe(10);
    expect(count(naive)).toBe(16);
  });

  // Mutation this catches: dropping the rootStyle argument. Design tokens ride
  // on the .rsm root; losing them renders an unstyled document that still looks
  // structurally correct, which is exactly the failure that is invisible in a
  // diff of bullet text.
  it("carries design-token overrides onto the root", () => {
    const html = renderDraftHtml({
      career,
      overlay: [],
      themes,
      baseSelection: base,
      overrides: { design: { "--rsm-accent": "#123456" } },
    });
    expect(html).toContain("#123456");
  });

  // Mutation this catches: passing `merged` rather than `doc.career` to
  // renderBody. compressAfter is applied to the RECORD (rules.compressAfter),
  // not as a render option, so the wrong argument renders every role in full.
  it("honours a compressAfter override", () => {
    const html = renderDraftHtml({
      career,
      overlay: [],
      themes,
      baseSelection: base,
      overrides: { selection: { compressAfter: 2 } },
    });
    expect((html.match(/rsm-role-title/g) || []).length).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/draft-render.test.ts`
Expected: FAIL — cannot resolve `@/lib/draft-render`.

- [ ] **Step 3: Implement**

```ts
// lib/draft-render.ts
//
// Render a working draft to the same HTML the tailor screen shows.
//
// The composition is otherwise split across loadResumeContext (a "use server"
// action) and ResumeDocument (a client component), so nothing could execute it
// end to end — including a test. The checkpoint written by restoreSavedVersion
// needs exactly this, and a checkpoint that renders anything else is a document
// the user never had.
//
// Order is load-bearing at three points, each of which has a test:
//   - effectiveCareer BEFORE effectiveDocument, so overlay bullets and text
//     overrides exist to be selected;
//   - doc.career (not the merged record) into renderBody, because a
//     compressAfter override is applied to rules.compressAfter;
//   - rootStyle passed, or design tokens vanish and the document renders
//     unstyled while still looking structurally right.
import { effectiveCareer } from "@/lib/effective-career";
import { effectiveDocument } from "@/lib/effective-document";
import { styleAttributeFor } from "@/lib/resume-design-tokens";
import { renderBody } from "@/lib/resume-render/render";
import type { CareerRecord, ResumeSelection } from "@/lib/resume-render/render";
import type { ResumeOverrides } from "@/lib/resume-overrides";
import type { OverlayBullet } from "@/lib/settings-store";

export function renderDraftHtml(input: {
  career: CareerRecord;
  overlay: OverlayBullet[];
  themes: string[];
  baseSelection: ResumeSelection;
  overrides: ResumeOverrides;
}): string {
  const { career: merged } = effectiveCareer(
    input.career,
    input.overlay,
    input.overrides.text || {}
  );
  const doc = effectiveDocument(merged, input.baseSelection, input.themes, input.overrides);
  const rootStyle = styleAttributeFor(input.overrides.design || {});
  return renderBody(doc.career, doc.selection, rootStyle);
}
```

If `renderBody`'s third parameter is named or shaped differently, read
`lib/resume-render/render.d.ts` and `components/resume/ResumeDocument.tsx:56`
and match the call site there exactly — do not guess.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run lib/draft-render.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/draft-render.ts lib/draft-render.test.ts
git commit -m "feat: render a working draft to HTML outside the client"
```

---

### Task 5: Write `content` and `kind`; split the save actions

**Files:**
- Modify: `lib/types.ts` (`SavedResumeSummary`, `SavedResume`, `SaveResumeInput`)
- Modify: `app/actions/saved-resumes.ts`
- Modify: `components/resume/TailorPanel.tsx:106`
- Modify: `components/resume/SavedResumePanel.tsx:48`

**Interfaces:**
- Consumes: `expiresAtFrom` with a day count (Task 2).
- Produces: `saveResumeFromDraft(input: { jobId: string; html: string; roleTitle: string; company: string; label?: string | null; allowDuplicate?: boolean; pageMargin?: string | null })` and `saveResumeAsNewVersion(input: { fromSavedId: string; html: string; label?: string | null; allowDuplicate?: boolean; pageMargin?: string | null })`, both returning `{ id?: string; duplicateOf?: string; error?: string }`. `SavedResumeSummary` gains `hasContent: boolean` and `kind: "save" | "checkpoint"`.

Why two actions rather than a required `content` field: `content` must be read
SERVER-side. `app/resume/page.tsx:96` passes the EFFECTIVE selection to
`TailorPanel` and discards `baseSelection`, so a client-supplied `content` would
carry the effective selection and be double-applied on every later render. And
`SavedResumePanel` has no selection at all — it captures a frozen row's DOM — so
a required field there would have no correct value to pass.

- [ ] **Step 1: Write the failing test**

Append to `app/actions/saved-resumes.test.ts`:

```ts
import { savedRowToSummary } from "@/app/actions/saved-resumes-shape";

describe("savedRowToSummary", () => {
  const row = {
    id: "s1",
    job_id: "j1",
    role_title: "Director",
    company: "Acme",
    label: null,
    created_at: "2026-09-08T00:00:00.000Z",
    expires_at: "2026-11-07T00:00:00.000Z",
    page_margin: null,
    kind: "checkpoint",
    has_content: true,
  };

  // Mutation this catches: selecting `content` itself into the list. lib/types.ts
  // documents why `html` is excluded from the summary — at up to 512 KB a row it
  // would ship every document in the tenant on one page load — and `content`
  // carries the full selection plus overrides.text, which is arbitrary rewritten
  // bullet prose. The affordance needs a boolean, so the summary carries one.
  it("carries a boolean, never the content payload", () => {
    const s = savedRowToSummary(row);
    expect(s.hasContent).toBe(true);
    expect(Object.keys(s)).not.toContain("content");
  });

  // Mutation this catches: defaulting kind to "save" in the mapper. A checkpoint
  // mislabelled as a save reads as a document the user chose to keep, and its
  // 3-day clock becomes invisible.
  it("preserves the row's kind", () => {
    expect(savedRowToSummary(row).kind).toBe("checkpoint");
    expect(savedRowToSummary({ ...row, kind: "save" }).kind).toBe("save");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/actions/saved-resumes.test.ts`
Expected: FAIL — cannot resolve `@/app/actions/saved-resumes-shape`.

- [ ] **Step 3: Extract the mapper, then implement**

`app/actions/saved-resumes.ts` is `"use server"`, which forbids non-async
exports, so the mapper cannot be exported from it. Create
`app/actions/saved-resumes-shape.ts` (no `"use server"`):

```ts
// app/actions/saved-resumes-shape.ts
// Row -> summary, in its own module because app/actions/saved-resumes.ts is
// "use server" and may export only async functions. Same split, same reason, as
// lib/fit-prompt.ts against app/actions/parse-role.ts.
import type { SavedResumeSummary } from "@/lib/types";

export interface SavedSummaryRow {
  id: string;
  job_id: string | null;
  role_title: string;
  company: string;
  label: string | null;
  created_at: string;
  expires_at: string;
  page_margin: string | null;
  kind: string;
  has_content: boolean;
}

export function savedRowToSummary(r: SavedSummaryRow): SavedResumeSummary {
  return {
    id: r.id,
    jobId: r.job_id,
    roleTitle: r.role_title,
    company: r.company,
    label: r.label,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    pageMargin: r.page_margin,
    kind: r.kind === "checkpoint" ? "checkpoint" : "save",
    hasContent: r.has_content === true,
  };
}
```

In `lib/types.ts`, add to `SavedResumeSummary`:

```ts
  /** How the row was created. 'checkpoint' rows are written by the app before a
   *  restore and carry a shorter retention (lib/resume-retention.ts). */
  kind: "save" | "checkpoint";
  /**
   * Whether this row records the {themes, selection, overrides} that produced
   * it, and can therefore be reopened as a draft. False for every row saved
   * before migration 021. A BOOLEAN, not the payload: the archive list renders
   * every live row in the tenant, and `content` carries the full selection and
   * arbitrary rewritten bullet text — the same reason `html` is excluded above.
   */
  hasContent: boolean;
```

In `app/actions/saved-resumes.ts`:

1. Delete the local `toSummary` and import `savedRowToSummary` from the new module.
2. Change the list query (currently `:121`) to select the boolean, not the payload:

```ts
    "select id, job_id, role_title, company, label, created_at, expires_at, page_margin, kind, " +
      "(content is not null) as has_content " +
      "from saved_resumes where tenant_id = $1 and " + LIVE_PREDICATE + " order by created_at desc",
```

3. Change `getSavedResume` (currently `:141`) to add `content, kind` to its select list, and carry `content` onto the returned `SavedResume`.
4. Replace `saveResume` with a private `insertSavedRow` plus the two exported actions:

```ts
interface InsertInput {
  jobId: string;
  html: string;
  roleTitle: string;
  company: string;
  label?: string | null;
  allowDuplicate?: boolean;
  pageMargin?: string | null;
  content: unknown | null;
  kind: "save" | "checkpoint";
  retentionDays: number;
}

/** The one insert. Not exported: every caller goes through one of the two
 *  actions below, which differ in where `content` comes from — and getting that
 *  wrong is the difference between a reproducible row and a corrupt one. */
async function insertSavedRow(
  tenantId: string,
  input: InsertInput
): Promise<{ id?: string; duplicateOf?: string; error?: string }> {
  const clean = sanitizeResumeHtml(input.html);
  if (clean.error !== undefined) return { error: clean.error };
  const html = clean.html as string;
  const contentHash = createHash("sha256").update(html).digest("hex");

  if (!input.allowDuplicate) {
    const { data, error } = await rawQuery<{ id: string }>(
      "select id from saved_resumes where tenant_id = $1 and job_id = $2 and " +
        LIVE_PREDICATE +
        " order by created_at desc limit 1",
      [tenantId, input.jobId],
      tenantId
    );
    const described = describeWriteFailure(
      error ? error.message : undefined,
      "check for an identical saved résumé"
    );
    if (described !== undefined) return { error: described };
    if (data.length > 0) {
      const dup = await rawQuery<{ id: string }>(
        "select id from saved_resumes where tenant_id = $1 and id = $2 and content_hash = $3",
        [tenantId, data[0].id, contentHash],
        tenantId
      );
      if (dup.data.length > 0) return { duplicateOf: dup.data[0].id };
    }
  }

  const now = new Date();
  const { data, error } = await rawQuery<{ id: string }>(
    "insert into saved_resumes " +
      "(tenant_id, job_id, role_title, company, label, html, design_version, content_hash, expires_at, page_margin, content, kind) " +
      "values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id",
    [
      tenantId,
      input.jobId,
      input.roleTitle,
      input.company,
      input.label ? input.label : null,
      html,
      DESIGN_VERSION,
      contentHash,
      expiresAtFrom(now, input.retentionDays).toISOString(),
      input.pageMargin ? input.pageMargin : null,
      input.content === null ? null : JSON.stringify(input.content),
      input.kind,
    ],
    tenantId
  );
  const described = describeWriteFailure(error ? error.message : undefined, "save that résumé");
  if (described !== undefined) return { error: described };
  return { id: data[0].id };
}
```

Then the two exported actions. `saveResumeFromDraft` reads the draft row itself:

```ts
export async function saveResumeFromDraft(input: {
  jobId: string;
  html: string;
  roleTitle: string;
  company: string;
  label?: string | null;
  allowDuplicate?: boolean;
  pageMargin?: string | null;
}): Promise<{ id?: string; duplicateOf?: string; error?: string }> {
  const actor = await requireResumeAdmin();

  // Server-side, never from the caller. The tailor screen holds the EFFECTIVE
  // selection (app/resume/page.tsx:96 discards baseSelection), and storing that
  // would double-apply every override on the next effectiveDocument pass.
  const { data, error } = await rawQuery<{ content: unknown }>(
    "select content from tailored_resumes where tenant_id = $1 and job_id = $2",
    [actor.tenantId, input.jobId],
    actor.tenantId
  );
  const described = describeWriteFailure(
    error ? error.message : undefined,
    "read the draft for this résumé"
  );
  if (described !== undefined) return { error: described };

  return insertSavedRow(actor.tenantId, {
    ...input,
    content: data.length > 0 ? data[0].content : null,
    kind: "save",
    retentionDays: RETENTION_DAYS,
  });
}
```

`saveResumeAsNewVersion` copies the SOURCE row forward — never the draft, because
this button captures a frozen row's DOM and attaching the draft's selection would
produce a row whose `html` and `content` describe different documents:

```ts
export async function saveResumeAsNewVersion(input: {
  fromSavedId: string;
  html: string;
  label?: string | null;
  allowDuplicate?: boolean;
  pageMargin?: string | null;
}): Promise<{ id?: string; duplicateOf?: string; error?: string }> {
  const actor = await requireResumeAdmin();

  const { data, error } = await rawQuery<{
    job_id: string | null;
    role_title: string;
    company: string;
    content: unknown;
  }>(
    "select job_id, role_title, company, content from saved_resumes where tenant_id = $1 and id = $2",
    [actor.tenantId, input.fromSavedId],
    actor.tenantId
  );
  const described = describeWriteFailure(
    error ? error.message : undefined,
    "read the résumé you are saving a new version of"
  );
  if (described !== undefined) return { error: described };
  if (data.length === 0) return { error: "Could not find that saved résumé." };
  const src = data[0];
  if (src.job_id === null) {
    // The row outlived its job (016's ON DELETE SET NULL). job_id is NOT NULL on
    // insert, and the duplicate check's `job_id = $2` matches nothing under SQL
    // null semantics anyway — so this refuses rather than writing a row whose
    // dedupe is silently inert.
    return { error: "The tracked role this résumé came from was deleted, so it cannot be versioned." };
  }

  return insertSavedRow(actor.tenantId, {
    jobId: src.job_id,
    html: input.html,
    roleTitle: src.role_title,
    company: src.company,
    label: input.label,
    allowDuplicate: input.allowDuplicate,
    pageMargin: input.pageMargin,
    content: src.content ?? null,
    kind: "save",
    retentionDays: RETENTION_DAYS,
  });
}
```

Import `RETENTION_DAYS` from `@/lib/resume-retention` alongside the predicates.

5. Update the two call sites: `TailorPanel.tsx:106` calls `saveResumeFromDraft`
   (drop nothing — its current argument shape already matches). `SavedResumePanel.tsx:48`
   calls `saveResumeAsNewVersion({ fromSavedId: resume.id, html, label, allowDuplicate, pageMargin })`
   — it no longer passes `jobId`, `roleTitle` or `company`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run app/actions/saved-resumes.test.ts && npm run build`
Expected: PASS, and the build clean. The build is what finds any call site the edit missed.

- [ ] **Step 5: Commit**

```bash
git add lib/types.ts app/actions/saved-resumes.ts app/actions/saved-resumes-shape.ts app/actions/saved-resumes.test.ts components/resume/TailorPanel.tsx components/resume/SavedResumePanel.tsx
git commit -m "feat: saved rows record how they were built"
```

---

### Task 6: `restoreSavedVersion`

**Files:**
- Create: `app/actions/restore-saved-version.ts`
- Test: `app/actions/restore-saved-version.test.ts`

**Interfaces:**
- Consumes: `renderDraftHtml` (Task 4), `insertSavedRow` semantics (Task 5), `CHECKPOINT_RETENTION_DAYS` / `SUPERSEDED_CHECKPOINT_DAYS` (Task 2).
- Produces: `restoreSavedVersion(savedId: string): Promise<{ jobId?: string; checkpointId?: string; error?: string }>` and the pure `shouldCheckpoint(draft: unknown | null, newest: { content: unknown | null } | null): boolean`.

The action takes `savedId` and nothing else. If it accepted `jobId` — it is in the
URL and in client state — an arbitrary value would reach the `tailored_resumes`
upsert; RLS checks `tenant_id`, and the FK to `jobs` bypasses row security by
design (migration 016's own comment), so a caller could create a row in their own
tenant keyed to another tenant's job.

- [ ] **Step 1: Write the failing test**

```ts
// app/actions/restore-saved-version.test.ts
import { describe, expect, it } from "vitest";
import { shouldCheckpoint } from "@/app/actions/restore-saved-version";

const draft = { themes: ["ops"], selection: { positioningId: "gtm", bullets: {} }, overrides: {} };

describe("shouldCheckpoint", () => {
  // Mutation this catches: comparing content_hash (a hash of HTML) instead of
  // content. A pre-021 row has content null, so an HTML match would suppress the
  // checkpoint and the restore would overwrite the draft's only copy — the row
  // that "matched" cannot restore it back, because its own content is null.
  it("always checkpoints against a row that records no content", () => {
    expect(shouldCheckpoint(draft, { content: null })).toBe(true);
  });

  // Mutation this catches: suppressing whenever a newest row exists at all.
  it("checkpoints when the draft differs from the newest row", () => {
    expect(shouldCheckpoint(draft, { content: { ...draft, themes: ["data"] } })).toBe(true);
  });

  // Mutation this catches: never suppressing, which writes a full HTML document
  // every time the user opens a saved résumé.
  it("does not checkpoint when the draft is already the newest row", () => {
    expect(shouldCheckpoint(draft, { content: { ...draft } })).toBe(false);
  });

  // Mutation this catches: treating "no draft" as "nothing to compare, so write
  // one". There is nothing to preserve, and the row would duplicate the restored
  // document.
  it("does not checkpoint when there is no draft at all", () => {
    expect(shouldCheckpoint(null, { content: { ...draft } })).toBe(false);
    expect(shouldCheckpoint(null, null)).toBe(false);
  });

  // Mutation this catches: suppressing when no saved row exists yet. The draft
  // is unprotected and a restore would destroy it.
  it("checkpoints a draft when the job has no saved rows yet", () => {
    expect(shouldCheckpoint(draft, null)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/actions/restore-saved-version.test.ts`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Implement**

`shouldCheckpoint` must be exported from a non-`"use server"` module for the test
to import it — put the action in `app/actions/restore-saved-version.ts` with
`"use server"`, and `shouldCheckpoint` in `lib/checkpoint-decision.ts`, importing
it into the action. Update the test's import path to `@/lib/checkpoint-decision`
before Step 4.

```ts
// lib/checkpoint-decision.ts
//
// Whether restoring a saved version must first preserve the current draft.
//
// Compares CONTENT, not content_hash. The hash is over sanitized HTML, and two
// documents can share HTML while differing in what produced them: page_margin
// lives outside the captured innerHTML (migration 020's whole reason), so a
// draft differing only in overrides.pageMargin hashes identically. Worse, a row
// written before migration 021 has content null and cannot restore anything —
// suppressing against it destroys the draft's only copy.
export function shouldCheckpoint(
  draft: unknown | null,
  newest: { content: unknown | null } | null
): boolean {
  if (draft === null || draft === undefined) return false;
  if (newest === null) return true;
  if (newest.content === null || newest.content === undefined) return true;
  return JSON.stringify(draft) !== JSON.stringify(newest.content);
}
```

`JSON.stringify` equality is key-order sensitive. That is acceptable here and
deliberately not "fixed" with a deep compare: both sides come from the same
writer (`tailored_resumes.content`, round-tripped through jsonb), so a spurious
inequality writes one redundant checkpoint — the safe direction. A deep compare
that got a subtle case wrong would suppress one, which is the data-loss
direction.

```ts
// app/actions/restore-saved-version.ts
"use server";

import { requireResumeAdmin } from "@/lib/require-resume-admin";
import { rawQuery } from "@/lib/supabase";
import { describeWriteFailure } from "@/lib/write-failure";
import { shouldCheckpoint } from "@/lib/checkpoint-decision";
import { renderDraftHtml } from "@/lib/draft-render";
import {
  CHECKPOINT_RETENTION_DAYS,
  LIVE_PREDICATE,
  SUPERSEDED_CHECKPOINT_DAYS,
} from "@/lib/resume-retention";

export async function restoreSavedVersion(
  savedId: string
): Promise<{ jobId?: string; checkpointId?: string; error?: string }> {
  const actor = await requireResumeAdmin();
  // ... see steps below
}
```

The body, in order, aborting on any failure:

1. Read the saved row by `savedId`, tenant-scoped: `job_id, role_title, company, content`.
   Refuse if absent, if `job_id is null`, or if `content is null`.
2. Read `tailored_resumes.content` for that `job_id`.
3. Read the newest live saved row for that `job_id` (`order by created_at desc limit 1`,
   with `LIVE_PREDICATE`), selecting `content`.
4. If `shouldCheckpoint(draft, newest)`: read settings for the overlay
   (`readAllSettingsResult` → `careerOverlayFrom`), call `renderDraftHtml`, and
   insert a checkpoint row with `kind: "checkpoint"`,
   `retentionDays: CHECKPOINT_RETENTION_DAYS`, `label: "Checkpoint · " + <date>`,
   and `roleTitle` / `company` taken from **the saved row's own snapshot** —
   those columns are `NOT NULL` and no job read has happened here; borrowing S's
   identity is correct only because the checkpoint and S share a `job_id`, which
   is why this action derives `job_id` from S.
   **If the insert returns `{error}`, return it and write nothing further.**
5. Demote older checkpoints:

```ts
  await rawQuery(
    "update saved_resumes set expires_at = least(expires_at, now() + interval '" +
      SUPERSEDED_CHECKPOINT_DAYS +
      " days') " +
      "where tenant_id = $1 and job_id = $2 and kind = 'checkpoint' and id <> $3",
    [actor.tenantId, jobId, checkpointId],
    actor.tenantId
  );
```

`least()` is load-bearing: an unconditional `now() + 3 days` would EXTEND a
checkpoint already 29 days old. The `kind = 'checkpoint'` filter is equally so —
without it this demotes deliberate Saves.

6. Upsert the saved row's `content` into `tailored_resumes` for that `job_id`.
7. Append a marker turn to `resume_chats` for that `(tenant, job)`:
   an assistant-role message reading
   `Restored the version saved on <date>. The document below is that version; anything I changed after it is no longer applied.`
   The thread is passed whole into `buildChatPrompt` (`resume-chat.ts:363`), so
   without this the model is told it already made changes the restored document
   does not contain — and `acceptProposedBullets` (`:712-718`) resolves ids
   against every proposal the thread ever carried, so a proposal from the
   discarded direction stays accept-able.
8. Return `{ jobId, checkpointId }`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run app/actions/restore-saved-version.test.ts && npm run build`
Expected: PASS (6 tests), build clean.

- [ ] **Step 5: Commit**

```bash
git add app/actions/restore-saved-version.ts lib/checkpoint-decision.ts app/actions/restore-saved-version.test.ts
git commit -m "feat: restore a saved résumé into the working draft, checkpointing first"
```

---

### Task 7: Wire the button

**Files:**
- Modify: `components/resume/SavedResumePanel.tsx`
- Modify: `components/resume/SavedResumeList.tsx` (or wherever `SavedResumeSummary` cards render — grep for `expiresAt`)

**Interfaces:**
- Consumes: `savedEditAffordance` (Task 3), `restoreSavedVersion` (Task 6), `SavedResumeSummary.kind` / `.hasContent` (Task 5).
- Produces: no new exports.

- [ ] **Step 1: Add the affordance to the panel's button row**

Beside "Save as new version", render from `savedEditAffordance({ hasContent: resume.hasContent, jobId: resume.jobId })`:

- `restore` — a button, "Edit this version →". On click, show the confirm below;
  on accept call `restoreSavedVersion(resume.id)` and, on `{jobId}`, navigate to
  `/resume?jobId=<jobId>`. On `{error}` render it in the panel's existing error
  style, and do not navigate.
- `draftOnly` — a link to `/resume?jobId=<jobId>` plus the affordance's `note`.
  It calls no action and writes no checkpoint.
- `unavailable` — the `note` as muted text, no control.

The confirm text, which must carry both warnings from the spec:

> Reopening rebuilds this résumé from the choices that produced it, against your
> current career record — it may differ from the document you see here. Hand
> edits in this version stay in the saved copy but do not come back editable.
> Your current draft for this role will be saved as a checkpoint first.

If the panel has uncaptured edits in its own `contentEditable` document, say so
too — navigating away discards them.

- [ ] **Step 2: Show the clock and the kind on saved cards**

Cards already render `expiresAt`. Add the `kind` distinction so a 3-day checkpoint
reads as urgent rather than vanishing: label `kind === "checkpoint"` rows
"Checkpoint" and keep the existing "expires in N days" line.

- [ ] **Step 3: Verify by using it**

```bash
npm run build && npm test
```

Then exercise the real flow against a tracked job: Save a résumé, chat one turn,
open the saved row, click "Edit this version", confirm, and check that (a) you
land on the tailor screen showing the saved version, (b) a `Checkpoint · <date>`
row now exists, and (c) clicking "Edit this version" on that checkpoint returns
you to the pre-restore state.

- [ ] **Step 4: Commit**

```bash
git add components/resume/
git commit -m "feat: edit a saved résumé from the archive screen"
```

---

### Task 8: Deploy and verify against the running build

**Files:** none.

- [ ] **Step 1: Confirm the migration is applied to production**

Task 1 Step 2 already applied it. Re-verify, because a check run before a deploy
proves nothing about the deploy:

```bash
railway link --project e1db9a0d-c4fd-410f-aa98-75d449e961af --environment production --service Postgres
railway run node -e "const pg=require('/Users/tomkeefe/Code Apps/gtm-job-search/.claude/worktrees/resume-update/node_modules/pg/lib/index.js');(async()=>{const c=new pg.Client({connectionString:process.env.DATABASE_PUBLIC_URL||process.env.DATABASE_URL});await c.connect();const r=await c.query(\"select column_name from information_schema.columns where table_name='saved_resumes' and column_name in ('content','kind')\");console.log(r.rows);await c.end();})()"
```

- [ ] **Step 2: Merge and push**

`web` deploys from GitHub `tkeefe66/gtm-job-search`, branch `main`, on push. Keep
`origin/main` current or the variable-change-rebuild trap returns.

- [ ] **Step 3: Verify the DEPLOYED commit, not the local one**

```bash
railway deployment list --service web --limit 1 --json | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['meta']['commitHash'])"
git rev-parse main && git rev-parse origin/main
```

All three must agree before believing any check against the live site.

---

## Self-Review

**Spec coverage.** Part 1 (`content`, `kind`, nullable, server-side read, two
actions, boolean in the list) → Tasks 1 and 5. Part 2 (`savedId`-only action,
render pipeline, suppression rule, abort rule, marker turn) → Tasks 4 and 6.
Part 3 (the confirm's two warnings) → Task 7 Step 1. Part 4 (affordance matrix)
→ Task 3, rendered in Task 7. Part 5 (tiers, demotion with `least()`,
visibility) → Tasks 2, 6 and 7 Step 2. Deploy order → Tasks 1 and 8.

**Known gap, carried from the spec rather than introduced here:** a restored
draft shows no "saved against an earlier document design" notice, because
`design_version` is not part of `content` and that string exists only in
`SavedResumePanel`. No task implements it; the spec records it as a known gap.

**Type consistency.** `SavedResumeSummary.hasContent` / `.kind` are defined in
Task 5 and consumed in Tasks 3 and 7 under those names. `shouldCheckpoint` is
defined in `lib/checkpoint-decision.ts` in Task 6 Step 3 — Task 6's test as first
written imports it from the action module and Step 3 says to correct the path
before running Step 4. `renderDraftHtml`'s input object is defined in Task 4 and
called in Task 6 Step 4 with the same field names.
