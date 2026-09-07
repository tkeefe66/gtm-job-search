# Saved résumés — design

**Date:** 2026-09-07
**Status:** approved after two-reviewer pass, not yet implemented
**Extends** `2026-08-24-resume-builder-design.md` and
`2026-08-25-resume-curation-design.md`, both of which stay accurate.

Revision note: an earlier draft of this file asserted four things about this
codebase that were false, each verified false against real code during review.
They are recorded at the bottom under "Corrections", because every one of them
is a mistake the next person is equally likely to make.

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

| Decision | Chosen | Rejected, and why |
|---|---|---|
| Save model | Explicit saves, many per role | Auto-saving into the single draft row: no way to compare two takes, and no save moment |
| Stored form | Frozen rendered HTML + `design_version` | Selection + per-bullet overrides: needs stable bullet ids through `renderBody` plus DOM diffing, and drops edits made outside a bullet |
| Freeze depth | Content frozen, presentation versioned | Snapshotting the token CSS per row: ~30KB/row and old résumés never pick up genuine design fixes |
| Retention | Cron purge + opportunistic purge + hide-on-read | Any one alone — see "Retention" |
| Export | `window.print()` + `.html` with `doc-page.js` inlined | A JS-free file: there are no `@page` rules in the token CSS to fall back on |
| Archive location | `/resume` with no `jobId` | A second nav tab: two résumé-shaped entries side by side |
| Job deletion | Saved résumés survive, `job_id` set null | `ON DELETE CASCADE` (today's behaviour): deleting a role after applying destroys the record of what was sent |
| Saved-résumé edits | Open → edit → save as a **new** version | In-place overwrite: the record of what was sent could change after the fact |
| Draft edits | Still lost on reload, but warned | Auto-persist or `localStorage`: blurs the save moment, or adds a third place résumé text lives, invisible to retention |

## Data model — `db/migrations/016_saved_resumes.sql`

`tailored_resumes` is unchanged and keeps its meaning: the **working draft**,
one per job, upserted by Regenerate, holding `{themes, selection}`. The new
table is the **archive** and holds frozen documents. Two tables because they
have different lifetimes, different shapes, and only one expires.

```sql
create table if not exists saved_resumes (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references users(id) on delete cascade,
  job_id         uuid references jobs(id) on delete set null,
  role_title     text not null,           -- snapshotted at save
  company        text not null,           -- snapshotted at save
  label          text,                    -- null, never ""; UI falls back to the date
  html           text not null,           -- sanitized frozen render
  design_version text not null,           -- see "What frozen means"
  content_hash   text not null,           -- sha256 of html, for the duplicate-save check
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null
);

create index if not exists saved_resumes_tenant_created_idx
  on saved_resumes (tenant_id, created_at desc);
create index if not exists saved_resumes_tenant_expires_idx
  on saved_resumes (tenant_id, expires_at);
```

Plus, mirroring migration 015 exactly: `enable`/`force row level security`,
`drop policy if exists` before `create policy` (the migration runner wraps each
file in one transaction), the `tenant_isolation` policy comparing `tenant_id`
to `nullif(current_setting('app.tenant_id', true), '')::uuid`, and an explicit
`grant select, insert, update, delete on saved_resumes to app_rw`.

Both indexes are `(tenant_id, ...)`-leading because **every** query against
this table is tenant-scoped, the purge included.

`"saved_resumes"` must be added **by hand** to `TENANT_TABLES` in
`lib/supabase.ts`: `tenant_id` is declared inline in `CREATE TABLE` rather than
retrofitted by `ALTER TABLE`, so `lib/supabase.test.ts`'s regex
(`/alter table (\w+)\s+add column if not exists tenant_id/gi`) cannot see it —
the same footnote 015 already carries. No change to that test is needed.

### Why `job_id` keeps its foreign key

An earlier draft dropped the FK, reasoning that `ON DELETE SET NULL` would run
a referential action against a table under `FORCE ROW LEVEL SECURITY` and that
this was unsafe to assume. **That reasoning is wrong and this codebase already
disproves it**: `tailored_resumes` is `force row level security`
(`015:24-25`) and carries `job_id uuid not null references jobs(id) on delete
cascade` (`015:15`), and jobs are genuinely deleted by `app/actions/jobs.ts:89`
— so that exact mechanism has run in production on every job deletion since 015
shipped. Postgres documents it unconditionally: referential integrity checks
always bypass row security, precisely so a cascade cannot leave orphans. The
same table's `tenant_id ... on delete cascade` depends on it too.

Keeping the FK also buys the archive something it otherwise has to pay for:
`ON DELETE SET NULL` makes "does this job still exist?" a property of the row
(`job_id IS NULL`), rather than a probe against `jobs` for every card rendered.

### Why `expires_at` is stored rather than computed

The retention window becomes data on the row instead of arithmetic repeated
across the purge, the list query and the countdown in the UI, and a row's own
expiry is inspectable in psql without knowing the constant.

## What "frozen" means

The row stores markup. Every pixel of its appearance comes from
`public/resume-design/tokens/*.css` **at view time**, and CLAUDE.md records
those files having already diverged from the vendored source (`--rail` 96→132,
`.rsm-role`'s `break-inside` removal) with a standing warning that a re-sync
silently reverts them. So a saved résumé's *layout* can still change after the
fact.

The promise this feature makes is therefore explicitly about **content**: the
words, the bullets chosen, and the edits made are exactly what was saved, and
cannot change. `design_version` records which design the row was authored
against — a constant bumped by hand whenever `public/resume-design/tokens/`
changes — so a row that predates a design change is identifiable rather than
merely suspect. The column costs one `text` today and cannot be added
retroactively for rows already written, which is the whole reason it is here
now rather than later.

## Retention

`lib/resume-retention.ts` — pure, tested, and the **single home of both
predicates**:

```ts
export const RETENTION_DAYS = 60;
export function expiresAtFrom(now: Date): Date;
export const EXPIRED_PREDICATE = "expires_at <= now()";  // purge collects
export const LIVE_PREDICATE    = "expires_at > now()";   // reads show
```

The predicates are exported as strings and interpolated by all three call
sites, rather than retyped into each SQL statement. This is the difference
between a test that bites and one that cannot: with the comparisons living in
SQL literals inside the purge and the two read actions, a vitest test of
`expiresAtFrom` cannot observe them, and changing the purge's `<=` to `<` would
leave every proposed test green. With them exported, a test asserts the two are
exact complements and a mutation to either fails it. CLAUDE.md records the
`compFloor` `>`-not-`>=` rule as a standing two-places hazard; this is that
hazard, closed rather than repeated.

A row at exactly `expires_at === now()` is expired: invisible to reads,
collected by the purge.

### The purge must pass the tenant id explicitly

This is the design's one genuinely dangerous detail. `app_rw` is created
`nosuperuser` and `nobypassrls` (`003_rls.sql:18,24`), and `tenant_isolation`
compares `tenant_id` to a per-connection GUC — **a query against a tenant table
with no tenant set returns zero rows, with no error.**

The GUC is set by `withTenant` (`lib/supabase.ts:192-229`), reached from exactly
two places, both of which take the tenant id as an **explicit argument**:
`QueryBuilder.execute()` via `forTenant`, and `rawQuery(text, values, tenantId)`
(`lib/supabase.ts:453-455`). **`runAsTenant` does not set it** — it only writes
an `AsyncLocalStorage` value (`lib/platform-context.ts:60-63`), which matters
only when the code inside it calls a server action that resolves the tenant via
`resolveTenantId()`. That is why `crawl-next` needs it and why a module doing
its own SQL does not.

So the purge follows `getBudgetOverview` (`app/actions/admin.ts:159-166`,
`:205-207`), which passes the tenant straight to `rawQuery` and uses no
`runAsTenant` at all:

```
rawQuery("delete from saved_resumes where tenant_id = $1 and " + EXPIRED_PREDICATE + " returning id",
         [tenantId], tenantId)
```

The third argument is what puts a policy in front of the statement. Omitting it
produces exactly the silent zero-row delete this section exists to prevent.
`lib/supabase.ts:441-446` states the rule directly: raw SQL is invisible to the
builder's registry, so that parameter is the only thing protecting it —
**adding `"saved_resumes"` to `TENANT_TABLES` protects none of these queries.**

### The query builder cannot express most of this

`QueryBuilder` supports only `.eq` and `.neq` (`lib/supabase.ts:275-282`).
There is no `lt`/`gt`/`lte`/`in`. So the purge (`<=`), both reads (`>`), and
bulk delete (`IN`) all go through `rawQuery(sql, values, tenantId)`. Only
`saveResume` and single-id `deleteSavedResume` can use `forTenant`.

### Enumeration

`listCrawlableTenants()` must **not** be reused: it filters `status = 'active'`
(`app/actions/admin.ts:136`), which is right for spending money on a crawl and
wrong for a retention guarantee — a suspended or pending user's saved résumés
would never be purged. A new `listAllTenantIds()` in `app/actions/admin.ts`
selects every row in `users` (not an RLS-protected table, so no tenant scope is
needed), guarded by `if (!isPlatform()) throw new Error("Not authenticated")` —
that **literal string**, because `auth-required.test.ts:85` asserts
`rejects.toThrow(/Not authenticated/)` and the sibling idiom in this same
feature (`requireResumeAdmin`) throws `"Not authorized"`, which would not match.

### `lib/saved-resume-purge.ts`

Dependency-injected so both of its interesting behaviours are testable as pure
logic, which `npm test` is scoped to:

```ts
runPurge({ listTenants, purgeTenant, now }): Promise<PurgeReport>
```

One tenant's failure is logged and skipped, never fatal to the others — the
rule `crawl-next` applies to a failed candidate read. The report distinguishes
them: `{ deleted, tenants, failed, oldestSurviving }`.

### Three mechanisms, because the promise is about storage

- **Cron purge** — the primary.
- **Opportunistic purge** — `listSavedResumes` deletes the calling tenant's
  expired rows before listing. Already tenant-scoped, one indexed statement.
  This exists because the promise is "nothing stored past 60 days" and CLAUDE.md
  records this repo's cron route 404-ing nightly for days with nothing
  surfacing it; an active user's own retention must not depend on cron uptime.
- **Hide-on-read** — both reads filter `LIVE_PREDICATE`, so a purge outage
  cannot surface an expired résumé.

The cron response carries `oldestSurviving` (the minimum `expires_at` still in
the table) so a stalled purge is detectable from its own output, and returns
non-200 when `failed > 0` — a run that reports `{deleted: n}` while half the
tenants errored is the silent-success shape `.claude/skills/swallowed-string-errors`
exists to prevent.

### What 60 days does and does not cover

Stated plainly because a user told "nothing is kept past 60 days" would
otherwise infer more than is true:

- **Covered:** every `saved_resumes` row.
- **Not covered:** `tailored_resumes`, the working draft, which does not expire
  — and its `{themes, selection}` plus the checked-in `content/resume.json`
  reconstitutes the document. It is résumé content by reference. Deleting the
  last saved résumé for a job deliberately does **not** delete that job's draft
  row; the draft is a tailoring cache, not an archive entry.
- **Not covered:** Railway Postgres backups, which retain deleted rows past 60
  days on their own schedule.
- **Not covered:** anything the user downloaded.

### `app/api/cron/purge-resumes/route.ts`

Third cron route. `export const dynamic = "force-dynamic"`, matching both
existing routes. `cronAuthorized(req)` from `lib/cron-auth.ts`, unchanged and
fail-closed, and `runAsPlatform` is entered **after** the secret check, never
before — the platform identity is granted by `CRON_SECRET`, not by reaching the
file. `?dry=1` counts without deleting, following the doctrine that any
presence of `dry` means dry-run unless explicitly disabled, so an unrecognised
spelling fails toward not writing.

One line is added to the `crawler` service's start-command loop to call it.
**CLAUDE.md's list of deliberately-public surfaces must be updated to name
three cron routes rather than two** — no test enumerates public routes, so only
review catches an unamended list.

## Capture and sanitization

### What is captured

`docPageEl.innerHTML` — **not** the `.rsm` div's `innerHTML`. `document.css:5`
scopes the entire design to `.rsm` (`.rsm{...}`, `.rsm a{...}`, `.rsm-header{...}`),
and that wrapper is emitted by `renderBody` (`render.js:127`). Capturing one
level too deep loses the root every selector hangs off, and the saved résumé
renders as unstyled body text on every later view — a defect invisible until
after the row is written. `saveResume` rejects a sanitized document with no
`.rsm` root rather than storing one.

**Page guides must be stripped before capture.**
`public/resume-design/rsm-page-guides.js:138` does `rsm.appendChild(g)`, so the
on-screen "Page 2" overlay divs live *inside* the captured subtree, and their
styles are injected into `document.head` (`:59`) rather than travelling with
them. Its `@media print` hide (`:57`) is why this has never shown up in
printing. Left in, they would freeze stale break markers into every row and
render as literal stray "Page 2" text in the downloaded file. The capture
removes every `.rsm-page-guide` node, the sanitizer drops that class as
belt-and-braces, and a test asserts a captured document contains none.

### The allowlist

**Derived from three sources, not one.** An earlier draft took it from
`renderBody`'s literal tag output, which is wrong twice over:

1. **The career record contains markup.** `render.js` deliberately does *not*
   escape three fields — bullet text (`:155`), role title (`:149`), and the
   `<b>` interpolations at `:161`/`:173` — and `content/resume.json` holds **22
   `<strong>` tags** inside bullet text. An allowlist without `strong` silently
   strips every bold run from every archived résumé.
2. **The HTML being saved is `contentEditable` output, not renderer output.**
   Enter inserts `<br>` or a bare `<div>`; Cmd-B inserts `<b>` or `<span style>`;
   paste brings arbitrary markup. Stripping `<br>` deletes a user's line breaks
   at save with no message — a likelier bug than the `<img onerror>` paste the
   sanitizer is built for.

Allowed tags: `div span p b strong i em u br section header h1 h2 h3 ul ol li
dl dt dd a`. Attributes: `class` on all (restricted to `rsm-*` via
`allowedClasses`, minus `rsm-page-guide*`), `href` on `a` limited to `http`,
`https`, `mailto`. Everything else dropped, including every `on*` handler,
`script`, `iframe`, `img`.

**One exception:** `render.js:169` emits `style="margin-bottom:0"` on the last
`<section>` (`rows(..., last)` at `:179`, and `content/resume.json:755` has a
non-empty `education` array, so this is on every render today). Stripped, the
last section regains its `--gap-section` bottom margin, which at a page
boundary is the difference between one page and two. `allowedStyles` permits
`margin-bottom` on `section` only.

Do **not** override `sanitize-html`'s default `nonTextTags`
(`['script','style','textarea','option']`) — that default is what drops
`<script>`'s *contents* rather than only its tag, and a "script stripped" test
would pass against `disallowedTagsMode: 'escape'` while the payload survived as
text.

**`@types/sanitize-html` goes in `devDependencies` in the same change.**
`sanitize-html` v2 ships no declarations; `tsconfig.json` sets `strict: true`
and `skipLibCheck` does not help, because the *import* itself raises TS7016 and
`npm run build` typechecks.

`saveResume` rejects HTML over **512 KB** with a stated reason rather than
truncating. `2026-08-25-resume-curation-design.md:118-128` established that
Server Actions here cap request bodies at 1 MB by default; 512 KB of HTML plus
React's action encoding sits under that, and the spec's own reason for the cap
is that exceeding the framework limit surfaces as an opaque error rather than a
sentence. The client checks the size before calling and shows the reason
itself, so the framework limit is never the thing the user meets.

### The build trap

`tsconfig.json` declares no `target`, so `npm run build` typechecks at **ES5**.
In this module and its tests: no `/u` flag, no `\p{...}` escapes, and no
`for...of` or spread over a `Set`/`Map` (TS2802 without `downlevelIteration`) —
arrays only. `npx tsc --noEmit --target es2017` does not reproduce any of these.

## Server actions — `app/actions/saved-resumes.ts`

A new file rather than growth in `app/actions/resume.ts` (already 214 lines and
focused on tailoring).

```ts
saveResume({ jobId, html, label, roleTitle, company })  // → { id?, error? }
listSavedResumes()                                      // → { resumes: SavedResumeSummary[], error? }
getSavedResume(id)                                      // → { resume: SavedResume | null, error? }
deleteSavedResume(id)                                   // → { error? }
deleteSavedResumes(ids)                                 // → { deleted: number, error? }
```

`saveResume` takes `roleTitle`/`company` from the caller rather than reading the
job row, because it must still succeed when the job is already gone and both
columns are `not null`. It reads them from the job when `jobId` still resolves,
and falls back to the caller's values otherwise.

```ts
interface SavedResumeSummary {
  id: string; jobId: string | null;   // null ⇒ the role was deleted
  roleTitle: string; company: string;
  label: string | null; createdAt: string; expiresAt: string;
}
```

`html` is deliberately **not** on the summary — at up to 512 KB per row it must
be fetched on demand by `getSavedResume`, or the archive list ships every
document in the tenant.

`requireResumeAdmin` moves from `app/actions/resume.ts` to
`lib/require-resume-admin.ts` and both files import it. One shared check, not a
hand-copy. The move is also *necessary* for a reason worth recording: in a
`"use server"` file every export becomes a POSTable RPC endpoint addressed by an
id in the client bundle, so exporting an auth helper from `resume.ts` would
publish it.

**The auth guard is the first statement of every action and is never inside a
`try`.** Only database and model failures are caught. This is load-bearing:
`auth-required.test.ts` asserts each export *throws* `/Not authenticated/`, and
the natural way to honour the `{ error?: string }` contract — a top-level
`try/catch` — would convert that throw into a returned `{ error }` and fail the
test. Every existing action gets this right (`app/actions/resume.ts:126`, `:174`,
`:209`).

Failures otherwise route through `describeWriteFailure` and callers branch on
`!== undefined`, never truthiness — an unreachable database produces an
`AggregateError` whose message is `""`, which `if (res.error)` reads as success.
`.claude/skills/swallowed-string-errors` governs.

### Error states

Enumerated because "returns `{error?}`" specifies a shape, not behaviour:

- `deleteSavedResume` on an already-purged row → success, `{ }`. Deleting
  something already gone is the outcome the user wanted.
- `getSavedResume` on an expired-but-unpurged id → `{ resume: null }`; the
  `?savedId=` screen renders a not-found state naming expiry as the likely
  cause.
- **Save as new version** from a row that expired while the tab sat open →
  succeeds, and starts a fresh 60 days. The user is saving a document they are
  looking at.
- `saveResume` with a sanitized document lacking a `.rsm` root, or over 512 KB →
  refused with the reason.
- **Duplicate save**: `content_hash` is compared against that job's newest saved
  row and the client confirms ("identical to the version you saved at 14:02 —
  save anyway?") rather than silently creating cards that differ only by
  timestamp. Editing a label after the fact is out of scope; the confirm
  prevents the case that motivated it.

## UI

Three modes of `/resume`, discriminated by search param; **`savedId` wins over
`jobId`** when both are present. The existing Résumé nav tab needs no change,
and `RolesTable.tsx`'s "Tailor resume →" link is unchanged.

### `/resume` — the archive

Every non-expired saved résumé, with a count. Grouped by role: the group key is
`job_id`, falling back to `role_title|company` once the job is gone. Groups are
ordered by their newest save; within a group, newest first.

Each card: role title @ company, save date, optional label, and
`expires in N days` (emphasised under 7). Per card: **Open** and **Delete**,
plus multi-select with **Delete selected** once more than one is checked — the
shape `link-health.ts`'s report uses, and for the same reason: a bulk control
far from the rows it acts on reads as a button that does nothing. The confirm
names the count and says the deletion cannot be undone.

**Print and Download are deliberately not on the card.** Both need the row's
HTML mounted in a `<doc-page>` to have any print geometry at all, and printing
card 3 would require hiding cards 1, 2, 4…N — CLAUDE.md's standing warning that
a new `window.print()` surface needs its own `print:hidden` scoping, with a
harder version of the problem. Both route through **Open**.

Empty state keeps the current copy pointing at Roles.

### `/resume?jobId=…` — the draft

As today, plus a **Save** button (enabled whether or not anything was edited —
saving the algorithmic render as-is is legitimate) with an optional inline label
field; blank stores `null`, not `""`, so "unlabelled" is one state. After a save:
an inline confirmation naming what was saved, and a link to it.

An unsaved-edits marker appears once the document receives input. **Regenerate
gets its own confirm when that flag is set** — Regenerate is a React state
change that re-sets `dangerouslySetInnerHTML` (`ResumeDocument.tsx:59-63`), not
a navigation, so `beforeunload` never fires for it. `beforeunload` covers tab
close and external navigation only; `window.print()` does not fire it either.

Below: that role's existing saved versions, linking to `?savedId=`.

Edits remain live-DOM only. Save is what makes them durable, said in the UI
rather than only in a comment.

### `/resume?savedId=…` — one saved résumé

Frozen HTML mounted in a `<doc-page>`, editable in place, **Save as new
version** (never overwrites the row that was opened), Print, Download, Delete.
Saved résumés are immutable; this is the only way to iterate on one.

## Download

A client-side `Blob` containing the frozen markup, the six token CSS files
inlined in `styles.css`'s own `@import` order, **and `doc-page.js` inlined**.

The component is not optional. Its own source says "never write your own
`@page` rule or hard-code paper dimensions in the content" (`doc-page.js:30`),
and there are **no `@page` rules anywhere in the token CSS** — all print
geometry lives in the component, which at print injects `@page { margin: 0 }`
to deny Chrome its header/footer margin box and moves the visual margin onto
the sheet's own padding (`:118-120`), plus WebKit/Chrome divergences
(`:339-343`). `spacing.css:10` also records that `--rail: 132px` was sized
against doc-page.js's global `text-wrap:balance` on headings, so a file without
it wraps section labels differently — the exact defect that forced 96→132.
"No JavaScript in the download" was a preference, and it costs fidelity.

A test parses `styles.css`'s `@import` lines and asserts the inlined array
equals them, so the CSS list cannot drift from the stylesheet — the same
two-places discipline applied to the retention predicates.

**"Self-contained" excludes web fonts.** `tokens/fonts.css` `@import`s
Newsreader and JetBrains Mono from Google Fonts; opened offline the file falls
back to the declared Georgia/Times and system-mono stacks.

Select-all-copy from the opened file into Google Docs preserves formatting,
which is the export path the base design doc already assumes.

## Auth invariants

- Every `page.tsx` calls `requireActorPage()` — `/resume` already does and
  gains no new page files; all three screens are search-param variants.
- Every exported server action refuses a session-less call.
  `auth-required.test.ts` globs `app/actions/*.ts` with no per-file allowlist
  (`CRON_CALLED` is a two-name set), so `saved-resumes.ts` is covered on
  creation — **subject to the two conditions above**: the guard is the first
  statement and uncaught, and `listAllTenantIds` throws the literal
  `"Not authenticated"`.
- The new cron route joins the deliberately-public list and must be named there.

**The session check is not the admin check.** `2026-08-24-resume-builder-design.md:543-549`
states that the blanket test "passes regardless of whether the `isAdmin` gate is
even present," which is why it demanded a dedicated non-admin refusal test.
This change moves `requireResumeAdmin` to a new file — the single edit most
likely to break that gate — so **the existing non-admin refusal test is extended
to every export of `saved-resumes.ts`.**

This feature stays admin-only, for the same reason tailoring is:
`content/resume.json` is one checked-in career record, not a per-tenant one.

## Testing

`npm run build && npm test` is the gate. Per the global `mutation-first-tests`
skill, each of these asserts a boundary, a filter or a default, so each must be
shown failing against a deliberately broken implementation before it counts.

- `lib/resume-retention.test.ts` — `EXPIRED_PREDICATE` and `LIVE_PREDICATE` are
  exact complements; the 60-day boundary from both sides. Fails if either
  comparison is mutated alone.
- `lib/resume-sanitize.test.ts` — **fixture round-trip**: the full
  `renderBody(career)` output sanitizes byte-identically, so a tag added
  upstream in the vendored renderer or in `content/resume.json` fails the build
  instead of silently truncating documents. Plus: `<strong>` survives; `<br>`
  survives; a realistic *browser-produced* fragment survives; `on*` stripped;
  `<script>` stripped including contents; `javascript:` href rejected; the
  `.rsm` root required; `rsm-page-guide` nodes dropped; over-size rejected.
- `lib/saved-resume-purge.test.ts` — via `runPurge`'s injected dependencies:
  enumeration covers non-active tenants, and one tenant's failure does not
  abort the rest.
- Download CSS list equals `styles.css`'s `@import` list.
- The non-admin refusal test, extended to the new file.

Verified by hand, not by tests: print output, the downloaded file opened and
pasted into Google Docs, and the cron route via `?dry=1`.

## Deployment

1. Apply the migration with the repo's **forward-only ledger runner**, not by
   hand and not via `db/apply-schema.mjs` (which would re-create the
   `insights_cache` table `006_drop_insights.sql` dropped):

   ```bash
   railway run --service Postgres sh -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" node db/migrate.mjs --dry'
   railway run --service Postgres sh -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" node db/migrate.mjs'
   ```

   Applying 016 by hand desynchronises the `schema_migrations` ledger and makes
   the next run attempt it again.
2. Push to `main`; the `web` service deploys from GitHub automatically.
3. Add the purge call to the `crawler` service's start-command loop.
4. Verify against the deployed commit, not the local one:
   `railway deployment list --service web --limit 1 --json` carries
   `meta.commitHash`.

No new environment variables: the purge route reuses `CRON_SECRET`.

**One check worth running once**, because a whole section's reasoning rests on
it: `select current_user, rolsuper, rolbypassrls from pg_roles where rolname =
current_user`. Migration 003 creates `app_rw` `nologin` with its password set
out of band; if production's `DATABASE_URL` actually connects as Railway's
default superuser, RLS is bypassed and the per-tenant purge is merely correct
rather than necessary.

## Corrections to the first draft

Recorded because each was verified false against real code, and each is a
mistake the next person is equally likely to make:

1. **"A cross-tenant DELETE, then `runAsTenant` to scope it."** `runAsTenant`
   sets an AsyncLocalStorage value, not the Postgres GUC. The remedy
   reintroduced the silent zero-row delete its own section warned about. The
   tenant id goes to `rawQuery` as its third argument.
2. **"No FK, because a referential action under FORCE RLS is unsafe to
   assume."** `tailored_resumes` has done exactly that in production since
   migration 015.
3. **"The allowlist matches what `renderBody` emits."** It emits unescaped
   career-record markup (22 `<strong>` tags), and the saved HTML is
   `contentEditable` output carrying `<br>` besides.
4. **"Applied manually to production."** `db/migrate.mjs` is a ledger runner
   that applied 001–015.

## Out of scope

- Making the career record per-tenant. This stays admin-only until that happens.
- `.docx` export.
- Renaming a saved résumé after the fact.
- Sharing a saved résumé by link.
- Any change to how bullets are selected.

## Verified at deploy (2026-09-07)

**The role assumption holds, and it was checked against the app's own
connection rather than the migration's.** `railway run --service Postgres psql`
connects as `postgres`, which reports `rolsuper = t` and `rolbypassrls = t` —
reading that as the answer would have been wrong. The `web` service's
`DATABASE_URL` connects as **`app_rw`**, which is `rolsuper = f` and
`rolbypassrls = f`, holding exactly SELECT/INSERT/UPDATE/DELETE on
`saved_resumes`. Row security is therefore genuinely enforced for every
statement the app issues, which is what makes passing the tenant id as
`rawQuery`'s third argument NECESSARY rather than merely correct: without it a
tenant-table statement matches zero rows and returns no error.

Migration 016 applied at 2026-09-07 via `db/migrate.mjs` (16 on disk, 15
previously applied). Verified in the live schema: `relrowsecurity` and
`relforcerowsecurity` both true, the `tenant_isolation` policy present with both
USING and WITH CHECK, both tenant-leading indexes created, and both foreign keys
present — `job_id … ON DELETE SET NULL` and `tenant_id … ON DELETE CASCADE`.

**Hand-verification.** The plan's UI checks could not run before deploy — the
table did not exist in any database until migration 016 was applied, so Save had
nothing to write to. Confirmed working by the user against production on
2026-09-07, immediately after the deploy above. What that confirms is the check
the suite structurally cannot make: a saved résumé RENDERS STYLED, so the
capture took `docPageEl.innerHTML` and kept the `.rsm` root that `document.css`
scopes the design to. A capture one level deeper would have produced unstyled
body text, and nothing in `npm test` can see it — vitest's include list is
`lib/**` and `app/**`, and no test in this repo mounts a component.

Not separately walked item by item: the duplicate-save prompt, the downloaded
file's print fidelity, and the Google Docs copy/paste path. They are implemented
and unit-tested where they are pure (`resume-download.test.ts` pins the download
document's shape; `saved-resumes.test.ts` pins the admin gate), but no one has
stepped through them in the browser, and this record should not imply otherwise.
