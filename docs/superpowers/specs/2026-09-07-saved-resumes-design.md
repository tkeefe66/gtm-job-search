# Saved résumés — design

**Date:** 2026-09-07
**Status:** approved, not yet implemented
**Supersedes nothing.** Extends `2026-08-24-resume-builder-design.md` and
`2026-08-25-resume-curation-design.md`, both of which stay accurate.

## Problem

`/resume` tailors a résumé for a tracked role and shows it. Three things it
does not do:

1. **Edits are never captured.** `ResumeDocument` renders into a
   `contentEditable` `<doc-page>` with no `onInput` handler, by design — a
   reload or a Regenerate re-sets the HTML from the algorithmic selection and
   the edits are gone.
2. **There is no archive.** `tailored_resumes` holds one row per
   `(tenant, job)`, upserted by every Regenerate, and stores only
   `{themes, selection}` — pointers into `content/resume.json`, not a document.
   Regenerating overwrites the only record of what came before. `/resume` with
   no `jobId` is a dead end that just says "go to Roles".
3. **Nothing is ever deleted, and nothing expires.**

The user needs to look back at what résumé went with which role, to delete
saved copies on demand, and for nothing to be retained beyond 60 days.

## Decisions

Taken during brainstorming, recorded because each one closes off an
alternative that will otherwise look reasonable again later:

| Decision | Chosen | Rejected, and why |
|---|---|---|
| Save model | Explicit saves, many per role | Auto-saving into the single draft row: no way to compare two takes, and no save moment |
| Stored form | Frozen rendered HTML | Selection + per-bullet overrides: needs stable bullet ids through `renderBody` plus DOM diffing, and drops edits made outside a bullet (masthead, summary, section labels) |
| Retention | Cron purge **and** hide-on-read | Either alone: purge-only shows expired rows during a cron outage; read-only purge means "60 days of visibility", not 60 days of storage |
| Export | `window.print()` + self-contained `.html` | `.docx`: a new dependency whose output cannot carry the rail, tracking and page rules faithfully |
| Archive location | `/resume` with no `jobId` | A second nav tab: two résumé-shaped entries side by side, and today's dead-end screen survives |
| Job deletion | Saved résumés survive | `ON DELETE CASCADE` (today's behaviour): deleting a role after applying destroys the record of what was sent |
| Saved-résumé edits | Open → edit → save as a **new** version | In-place overwrite: the record of what was actually sent could change after the fact |
| Draft edits | Still lost on reload, but warned | Auto-persist or `localStorage`: blurs the save moment, or adds a third place résumé text lives, invisible to the retention policy |

## Data model — `db/migrations/016_saved_resumes.sql`

`tailored_resumes` is unchanged and keeps its current meaning: the **working
draft**, one per job, upserted by Regenerate, holding `{themes, selection}`.
The new table is the **archive** and holds frozen documents. Two tables rather
than one because they have different lifetimes, different shapes, and only one
of them expires.

```sql
create table if not exists saved_resumes (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references users(id) on delete cascade,
  job_id       uuid,                      -- provenance pointer; NO foreign key
  role_title   text not null,             -- snapshotted at save
  company      text not null,             -- snapshotted at save
  label        text,                      -- optional; UI falls back to the date
  html         text not null,             -- sanitized frozen render
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null
);
```

Plus, mirroring migration 015 exactly: `enable`/`force row level security`, the
`tenant_isolation` policy comparing `tenant_id` to
`nullif(current_setting('app.tenant_id', true), '')::uuid`, and an explicit
`grant select, insert, update, delete on saved_resumes to app_rw` (003's
default-privileges clause is not relied on alone). Indexes on
`(tenant_id, created_at desc)` for the archive list and on `(expires_at)` for
the purge.

`"saved_resumes"` must be added **by hand** to `TENANT_TABLES` in
`lib/supabase.ts`: `tenant_id` is declared inline in `CREATE TABLE` rather than
retrofitted by `ALTER TABLE`, so it is invisible to `lib/supabase.test.ts`'s
retrofit-pattern regex — the same footnote migration 015 already carries.

### Why `job_id` carries no foreign key

Saved résumés must outlive a deleted role, which rules out `ON DELETE CASCADE`.
The obvious replacement, `ON DELETE SET NULL`, makes Postgres run a referential
action against a table under `FORCE ROW LEVEL SECURITY` — plausibly fine (RI
checks are documented as bypassing RLS) but not something to assume in the one
place where being wrong means a role deletion either fails or silently skips
rows. Dropping the constraint removes the question. `job_id` is provenance;
`role_title` and `company` are what make the row readable once the job is gone,
and the UI offers a link back to the role only when that job still exists.

### Why `expires_at` is stored rather than computed

The retention window becomes data on the row instead of arithmetic repeated
across the purge, the list query and the countdown in the UI. The purge is then
one indexed `delete ... where expires_at <= now()`, and a row's own expiry is
inspectable in psql without knowing the constant.

## Retention

`lib/resume-retention.ts` — pure, tested:

- `RETENTION_DAYS = 60`
- `expiresAtFrom(now: Date): Date`
- The boundary is pinned explicitly: a row whose `expires_at` is exactly `now()`
  **is expired** (`<=` in the purge, `>` in every read). Stated here because
  this repo has been bitten by exactly one boundary drifting between two call
  sites before — see the `compFloor` `>`-not-`>=` rule in CLAUDE.md, which lives
  in two places and must not diverge. The same discipline applies: the purge
  predicate and the read predicate are complements of one another, and a test
  asserts that a row at the boundary is invisible to reads **and** collected by
  the purge.

### The purge must be per-tenant, not one cross-tenant DELETE

This is the design's one non-obvious constraint, and getting it wrong fails
silently. `app_rw` is neither superuser nor `BYPASSRLS`, and `tenant_isolation`
compares `tenant_id` to a per-connection GUC — **a query against a tenant table
with no tenant set returns zero rows, with no error**. A single
`delete from saved_resumes where expires_at <= now()` would therefore report
success and delete nothing, forever, and the only symptom would be rows quietly
outliving their retention window. `app/api/cron/crawl-next/route.ts` and
`getBudgetOverview` (`app/actions/admin.ts`) both carry this reasoning already;
the purge follows the same shape.

`lib/saved-resume-purge.ts`:

1. `runAsPlatform(...)` — enumerate tenants.
2. For each, `runAsTenant(tenantId, ...)` and delete that tenant's expired rows.
3. One tenant's failure is logged and skipped, never fatal to the others —
   the same rule `crawl-next` applies to a failed candidate read.

**Enumeration must not reuse `listCrawlableTenants()`.** That function filters
`status = 'active'`, which is right for spending money on a crawl and wrong for
a retention guarantee: a suspended or pending user's saved résumés would never
be purged. A new `listAllTenantIds()` in `app/actions/admin.ts` selects every row in
`users` regardless of status, guarded by `if (!isPlatform()) throw` exactly as
`listCrawlableTenants` is — it enumerates across tenants, so it must be
unreachable from a session-bearing caller. (A *deleted* user needs no
handling — `tenant_id references users(id) on delete cascade` takes their rows
with them.)

### `app/api/cron/purge-resumes/route.ts`

Third cron route. `cronAuthorized(req)` from `lib/cron-auth.ts`, unchanged and
fail-closed. `?dry=1` counts without deleting, following the batch route's
doctrine that any presence of `dry` means dry-run unless explicitly disabled, so
an unrecognised spelling fails toward not writing. Returns
`{ deleted: n, tenants: m }`. Returns JSON, never a redirect — so the
`req.url`/`localhost:8080` trap in CLAUDE.md does not apply.

One line is added to the `crawler` service's start-command loop on Railway to
call it once per run. **CLAUDE.md's list of deliberately-public surfaces must
be updated to name three cron routes rather than two** — that list is the
standing statement of what is intentionally unauthenticated, and a route added
without amending it is indistinguishable from a route someone forgot to guard.

### Hide-on-read

`listSavedResumes` and `getSavedResume` both filter `expires_at > now()`. Two
independent mechanisms, neither trusted alone: cron deletes, reads hide. A cron
outage cannot surface an expired résumé; a read-path bug cannot extend
retention.

## Sanitization — `lib/resume-sanitize.ts`

Saving `contentEditable` HTML and re-rendering it through
`dangerouslySetInnerHTML` is a stored-XSS surface. The realistic path is a paste
from a job posting carrying an `<img onerror=...>`; `/resume` is admin-only and
single-tenant, so the blast radius is small, but the row is stored and
re-rendered on every view, so the control belongs server-side rather than in
the client that produced the markup.

**`sanitize-html` is added as a dependency** (server-side only) and wrapped in
one module so the allowlist has a single definition and a test. Hand-rolling an
HTML parser is the standard way to ship a sanitizer bypass; a sandboxed iframe
would be stronger still but complicates the viewer, printing, and
`rsm-page-guides.js` for a threat this size.

The allowlist matches what `renderBody` actually emits — `div`, `span`, `p`,
`b`, `em`, `section`, `header`, `h1`, `h2`, `h3`, `ul`, `li`, `dl`, `dt`, `dd`,
`a` — plus `class` on all of them (the `.rsm-*` contract is what the design CSS
selects on) and `href` on `a`, restricted to `http`, `https` and `mailto`.
Everything else is dropped, including every `on*` handler, `style`, `script`,
`iframe` and `img`.

`saveResume` rejects HTML over **512 KB** with a stated reason rather than
truncating.

Note for implementation: `tsconfig.json` declares no `target`, so
`npm run build` typechecks at ES5 — no `/u` flag and no `\p{...}` escapes
anywhere in this module, and `npx tsc --noEmit --target es2017` will not
reproduce the failure.

## Server actions — `app/actions/saved-resumes.ts`

A new file rather than growth in `app/actions/resume.ts`, which is already 214
lines and focused on tailoring.

- `saveResume(jobId, html, label?)` → `{ id?: string; error?: string }`
- `listSavedResumes()` → `{ resumes: SavedResumeSummary[]; error?: string }`
- `getSavedResume(id)` → `{ resume: SavedResume | null; error?: string }`
- `deleteSavedResume(id)` → `{ error?: string }`
- `deleteSavedResumes(ids)` → `{ deleted: number; error?: string }`

`requireResumeAdmin` moves from `app/actions/resume.ts` to
`lib/require-resume-admin.ts` and both files import it. One shared check, not a
hand-copy — the failure mode `app/actions/auth-required.test.ts`'s own doc
comment names ("a hand-written check is one someone forgets when adding the
37th"). `resume.ts`'s existing behaviour is otherwise untouched.

Every action follows the `{ error?: string }` contract with **presence**
checks, not truthiness: failures go through `describeWriteFailure(...)` and
callers branch on `!== undefined`, because an unreachable database produces an
`AggregateError` whose message is `""` and `if (res.error)` reads that as
success. The project skill `.claude/skills/swallowed-string-errors` governs.

`saveResume` reads `role_title` and `company` from the job row at save time and
writes them onto the saved row. If the job is already gone it still saves, using
whatever the draft page was showing.

## UI

All three screens are `/resume`, discriminated by search param. The existing
Résumé nav tab needs no change.

### `/resume` — the archive

Every non-expired saved résumé for the tenant, newest first, grouped by role.
Each card: role title @ company, save date, optional label, and
`expires in N days` (emphasised under 7). Per card: **Open**, **Print**,
**Download**, **Delete**. Multi-select with a **Delete selected** action once
more than one is checked — the same shape `link-health.ts`'s report uses, and
for the same reason: a bulk control that lives far from the rows it acts on
reads as a button that does nothing.

Delete is a hard delete behind a confirm, with no undo tier. A recoverable
trash and a 60-day retention ceiling contradict each other.

Empty state keeps the current copy pointing at Roles.

### `/resume?jobId=...` — the draft

As today, plus:

- a **Save** button (enabled whether or not anything was edited — saving the
  algorithmic render as-is is legitimate), with an optional inline label field
  beside it; left blank, the card falls back to the save date, and `label` is
  stored as `null` rather than `""` so "unlabelled" is one state and not two,
- an unsaved-edits marker once the document receives input,
- a `beforeunload` guard, so leaving or Regenerating cannot silently discard
  work,
- a list of that role's existing saved versions, linking to `?savedId=`.

Edits remain live-DOM only. Save is what makes them durable, and that is now
stated in the UI rather than only in a comment.

### `/resume?savedId=...` — one saved résumé

Frozen HTML, editable in place, **Save as new version** (never overwrites the
row that was opened), Print, Download, Delete. Saved résumés are immutable;
this is the only way to iterate on one.

## Download

Client-side `Blob`, assembled from the frozen markup plus the design CSS
inlined in `styles.css`'s own `@import` order: `fonts`, `colors`, `typography`,
`spacing`, `elevation`, `document`. No JavaScript in the output and no
`<doc-page>` — a downloaded file is a plain document, not the paginating custom
element — so `@page` rules carry the print geometry instead.

**"Self-contained" excludes web fonts.** `tokens/fonts.css` `@import`s Newsreader
and JetBrains Mono from Google Fonts; a downloaded file opened offline falls
back to the declared Georgia/Times and system-mono stacks. Stated here so it is
a known property rather than a bug report later.

Select-all-copy from the opened file into Google Docs preserves formatting,
which is the export path the base design doc already assumes.

## Auth invariants

The three standing invariants in CLAUDE.md apply, and this change touches all
three:

- Every new `page.tsx` calls `requireActorPage()` — `/resume` already does, and
  gains no new page files, since all three screens are search-param variants of
  the existing route.
- Every exported server action refuses a session-less call.
  `app/actions/auth-required.test.ts` imports every file in `app/actions/` and
  calls every export, so `saved-resumes.ts` is covered the moment it exists —
  no test edit needed, and that is the point of the test's shape.
- The new cron route joins the deliberately-public list and must be named there.

`saveResume` and friends are admin-gated on top of that, matching `/resume`'s
existing `requireResumeAdmin`. This whole feature stays admin-only for the same
reason the tailoring does: `content/resume.json` is one checked-in career
record, not a per-tenant one.

## Testing

`npm run build && npm test` is the gate. New pure tests:

- `lib/resume-retention.test.ts` — the 60-day boundary, asserted from both
  sides: a row at exactly `expires_at === now()` is invisible to reads and is
  collected by the purge. Written so it fails if either predicate is changed
  alone.
- `lib/resume-sanitize.test.ts` — `on*` handlers stripped, `<script>` stripped,
  `javascript:` href rejected, `.rsm-*` classes and the emitted tag set
  preserved, over-size input rejected with a message.
- `lib/saved-resume-purge.test.ts` — enumeration covers non-active tenants, and
  one tenant's failure does not abort the rest.

Per the global `mutation-first-tests` skill: each of these asserts a boundary, a
filter or a default, so each must be shown failing against a deliberately broken
implementation before it counts as coverage. The retention boundary and the
purge's tenant enumeration are the two most likely to pass vacuously.

Not covered by tests, verified by hand: the print output, the downloaded file
opened in a browser and pasted into Google Docs, and the cron route via `?dry=1`.

## Deployment

1. `db/migrations/016_saved_resumes.sql` applied manually to production —
   **not** through `db/apply-schema.mjs`, which would re-create the
   `insights_cache` table that `006_drop_insights.sql` dropped.
2. Push to `main`; the `web` service deploys from GitHub automatically.
3. Add the purge call to the `crawler` service's start-command loop.
4. Verify against the deployed commit, not the local one:
   `railway deployment list --service web --limit 1 --json` carries
   `meta.commitHash`.

No new environment variables: the purge route reuses `CRON_SECRET`, which both
services already have.

## Out of scope

- Making the career record per-tenant. This feature stays admin-only until that
  happens, and nothing here assumes otherwise.
- `.docx` export.
- Sharing a saved résumé by link.
- Any change to how bullets are selected — `selectBullets` and the theme
  derivation are untouched.
