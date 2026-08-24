# AI-tailored resume builder — design, revision 2

Date: 2026-08-24
Status: approved for planning

Revision 1 was reviewed by three independent subagents, each against a
different lens (technical correctness, adversarial tenant-isolation
security, and scope/completeness). No security gap survived review, but two
factual errors and a set of real scope gaps did. This revision fixes all of
them.

## What changed from revision 1

- **The Claude Design project named "Resume design system" is not empty.**
  It's a regular project (not one of the account's formal Design System
  objects — those are `Tomkeefe.ai Design System`, `Dynasty Analyzer Design
  System`, and `Modernist`, listed separately) that already contains a
  finished, print-first set of résumé templates built from the actual
  source résumé — four variants, full type/color tokens, six React-shaped
  components, and its own handoff notes. Revision 1 said the template still
  needed to be designed; it doesn't. "Rendering and export" below is
  rewritten to reflect this and names the specific variant v1 ships.
- **The migration needs an explicit grant.** `003_rls.sql` relies on
  `alter default privileges` for future tables, but the codebase's own
  actual precedent for "new table + RLS in one migration"
  (`004_metering.sql`) grants explicitly anyway rather than trusting that
  alone. `tailored_resumes` now does the same.
- **The five `resume.ts` actions share one gate function**, not five
  hand-written copies of the same two-line check — the exact failure mode
  `auth-required.test.ts`'s own doc comment names ("a hand-written check is
  one someone forgets when adding the 37th [action]").
- **`tailored_resumes` is called out by name** as needing a manual addition
  to `TENANT_TABLES` in `lib/supabase.ts`, because the regression guard
  that's supposed to catch a missed tenant-scoped table only matches the
  `alter table ... add column` retrofit pattern, not an inline
  `create table` with `tenant_id` baked in — it would stay green even if
  the addition were forgotten.
- **A UI entry-point section is added.** Revision 1 specified five server
  actions and no caller for four of them. It now says exactly where in the
  app each one is invoked from.
- **Empty/missing-input behavior is now defined**, for both an unsaved base
  resume (refuse, before spending budget) and a job with sparse stored
  fields (omit the block, never refuse — `jobs.company`/`role_title` are
  the only fields guaranteed non-null, so there's always something to
  tailor from).
- **`saveBaseResume` now validates size**, but by rejecting over a generous
  cap rather than silently truncating — deliberately not copying
  `PROFILE_TEXT_MAX_CHARS`'s clip-on-write behavior, for a reason specific
  to this data (see "Validation" below).
- **`TailoredResume` is now a defined type** (a type alias for
  `BaseResume`), and the tailoring call's output contract is now specified
  precisely, including a defensive post-call check that stops the model
  from fabricating or altering anything outside summary/bullets/skill
  order.
- **`WorkHistoryEntry`/`EducationEntry` gained an `id` field** for stable
  React keys during editing.
- **A cheap overwrite-safety mitigation replaces the "no version history"
  gap** a reviewer flagged: destructive saves confirm first, rather than
  either building real versioning or leaving the user with zero recourse.
- **A deploy/rollout section is added**, matching the rigor of
  `2026-08-17-never-live-roles-design.md`'s "Deploy order is load-bearing"
  section rather than the vaguer "should be checked manually" revision 1
  had.

## The problem

The app finds and scores roles well but does nothing with the output: once
a role clears the fit bar, the user still writes a resume for it by hand,
outside the app, from scratch every time. This adds a resume builder that
starts from one structured "base resume" the user maintains once, and
produces a resume tailored to a specific tracked job on demand, rendered
through an already-designed template and exported by printing to PDF.

This is a single-owner feature bolted onto a public, multi-tenant app. The
hard constraint is not "build a resume builder" — it's "build a resume
builder that is invisible and inert for every tenant except the app owner,"
because every other design decision downstream has to satisfy that first.

## Scope for v1

**In scope**: one structured base resume per tenant; one existing designed
template, hand-reimplemented as a React component; an AI tailoring pass per
tracked job that rewrites the summary and reorders/re-emphasizes bullets and
skill order; PDF export via browser print; an optional one-time bootstrap
from the résumé text captured at onboarding, for tenants who onboarded that
way.

**Out of scope, named explicitly rather than left implicit**:

- **Re-fetching the full job posting.** `jobs` (`db/schema.sql`) stores
  only structured summary fields — `role_title`, `key_skills`,
  `fit_summary`, `seniority`, `department`, `salary_range`,
  `company_description` — never the posting's full text. Tailoring in v1
  works from those fields only. This is a real, deliberate quality
  ceiling, not a footnote: a tailoring pass with no job-description
  language to match against will read as competent reordering, not real
  keyword-matching. The natural v1.1 upgrade is to reuse the crawler's
  existing fetch-and-strip path (`lib/page-extract.ts`) at tailor time —
  deferred because that path is already fighting link rot hard
  (`repairJobLinks`, `never_live`, "Posting Closed"), and a live re-fetch
  would frequently fail for exactly the older postings a user most wants
  to tailor against. If tailoring quality disappoints in practice, this is
  where to look first.
- Multiple base resumes, or any version history of past tailored resumes.
  Regenerating a tailored resume for a job overwrites the previous one
  (see "Overwrite safety" below for the cheap mitigation this still gets).
- A choice of templates. One of the four already-designed variants ships
  in v1 (see "Rendering and export").
- Server-rendered PDF. Export is `window.print()` behind a print
  stylesheet — no PDF library, no server-side rendering path.

## Gating: reuse `actor.isAdmin`, add nothing new

The app already has exactly the primitive this needs: `ADMIN_EMAIL`
promotes into a stored `users.role` once, at first sign-in (`auth.ts`), and
`requireAdmin()` (`app/actions/admin.ts`) checks the stored `actor.isAdmin`
flag on every call rather than re-comparing email live. `ADMIN_EMAIL` is
scoped to the app owner alone, so the resume builder gates on the same
`actor.isAdmin` flag — no new env var, no new identity-comparison code path.

This matters more than it sounds like it should. An earlier version of this
design proposed a fresh `requireResumeBuilderAccess(actor)` check comparing
`actor.email` against a new allowlist env var on every call. That would have
reintroduced, at smaller stakes, exactly the mistake `lib/auth-policy.ts`
documents fixing elsewhere: *"IDENTITY IS `sub`, NEVER EMAIL"* — email is
mutable, and a waitlist keyed on email was judged unsafe for that reason.
Reusing `actor.isAdmin` avoids inventing a second, weaker identity primitive
that nothing else in the codebase would exercise or guard.

The tradeoff this accepts, worth stating rather than leaving implicit: the
resume builder's entire blast radius is now coupled to `ADMIN_EMAIL`'s
existing promotion mechanism, which has no "only one admin" guard of its
own — if that env var is ever repointed post-launch (the kind of Railway
variable edit this app's own CLAUDE.md documents as a recurring trap class)
and someone with the new address signs in, they inherit resume-builder
access the same way they'd inherit `/admin`. This is a pre-existing
property of `isAdmin`, not a new risk this feature introduces, and reusing
the flag is still correct — but the coupling is deliberate, not accidental.

**One shared gate function, not five copies.** `requireResumeAdmin()` in
`app/actions/resume.ts` — a small wrapper mirroring `requireAdmin()` in
`app/actions/admin.ts` exactly (`requireActor()` then `if (!actor.isAdmin)
throw`) — is the first statement in every one of the five exported actions.
Five independent hand-written copies of the same two lines is the specific
failure mode `auth-required.test.ts`'s own doc comment warns about: a check
someone forgets to copy into the sixth action later. One function, five
call sites.

**Page gate**: `/resume`'s `page.tsx` calls `requireActorPage()` as every
page does, then checks `actor.isAdmin` and redirects to `/discover` if
false — the same shape `app/admin/page.tsx` already uses. A redirect, not a
distinctive refusal page, is what makes the route actually inert rather
than merely blocked: a refusal that renders differently from a 404 still
confirms the route exists.

**Action gate**: every export in the new `app/actions/resume.ts` calls
`requireResumeAdmin()`, which itself calls `requireActor()` first
(satisfying `auth-required.test.ts`'s blanket session-less-call check, same
as every other action file) before checking `actor.isAdmin`.

**Nav / entry-point gate**: both the `/resume` nav link and the
per-row "Tailor resume" button on `/roles` (see "UI entry points" below)
render only when the server-rendered `actor.isAdmin` is true, passed down
from the same server-component source the nav already reads — no new
client-side check is invented.

## Data model

### `base_resume` — an `app_settings` row, not a new table

Structured contact info, summary, work history, education, and skills for
one tenant is exactly the shape `profile` already stores: a whole-object
jsonb value, replaced wholesale on save, repaired field-by-field on read
rather than rejected outright when malformed. `base_resume` becomes a
second standalone key in `app_settings` — like `PROFILE_KEY` and
`ONBOARDED_AT_KEY` in `lib/settings-store.ts`, deliberately **not** a member
of `SETTING_KEYS`/`mergeSettings`, because its value is a whole object and
folding it into the list/text/number shape group `mergeSettings` already
handles would force a fourth shape onto that function for no benefit. The
`(tenant_id, key)` primary key and the existing `on conflict (tenant_id,
key)` upsert in `lib/settings-store.ts` need no changes to support a new
key. No migration required for this half of the data model.

Shape:

```ts
interface ResumeContact {
  name: string;
  email: string;
  phone: string;
  location: string;
  links: string[]; // e.g. LinkedIn, portfolio — free-form, order-preserving
}

interface WorkHistoryEntry {
  id: string;        // client-generated (crypto.randomUUID()); stable React key
                      // across add/remove/reorder in the editor — array index
                      // is not safe for that once entries can be deleted
  company: string;
  title: string;
  startDate: string; // free-form ("2021", "Mar 2021") — not parsed, only displayed
  endDate: string;   // "" or "Present" both valid
  bullets: string[];
}

interface EducationEntry {
  id: string;         // same reason as WorkHistoryEntry.id
  school: string;
  degree: string;
  year: string;
}

interface BaseResume {
  contact: ResumeContact;
  summary: string;
  workHistory: WorkHistoryEntry[];
  education: EducationEntry[];
  skills: string[];
}

/** A tailored resume is a BaseResume with the same shape, produced by the
 *  model under the constraints in "Tailoring call" below. `jobId` and
 *  `generatedAt` live as their own columns on `tailored_resumes`, not
 *  nested inside this value — no wrapper type needed. */
type TailoredResume = BaseResume;
```

None of `ResumeContact`'s fields exist anywhere in `Profile` today — this is
new surface area, not a relabeling of something onboarding already
collects.

`resolveBaseResume(raw: unknown): BaseResume` in `lib/resume.ts` mirrors
`resolveProfile()`: unknown/malformed input repairs field-by-field against
an all-empty default rather than being rejected, and every returned value
is fresh (never a reference into a shared default), matching the contract
`resolveProfile`'s own doc comment states and enforces. Missing `id` fields
on repaired work-history/education entries are backfilled with a freshly
generated id, never left undefined — this repair function is also what
`bootstrapFromOnboarding()`'s extraction output is passed through before
the user ever sees it, so a malformed model response degrades to blank
fields the same way a malformed `app_settings` row would, not to a form
that crashes or shows `"undefined"`.

**Validation on write.** `saveBaseResume(data)` rejects (does not silently
truncate) a payload whose serialized size exceeds a generous cap —
recommend 20,000 characters, several times what a real two-page résumé
serializes to. This deliberately does **not** copy `PROFILE_TEXT_MAX_CHARS`'s
clip-on-write behavior (`lib/profile.ts`), even though that field's own
doc comment is the obvious precedent. The reason they call for different
handling: `fitBrain` is clipped because it's re-sent on every `scoreFit`
call across every discovered role — a recurring cost tax, and losing its
tail is low-stakes because it's prompt material, never rendered to the
user. A base resume is the literal document a person exports and prints;
silently cutting a bullet off mid-sentence in what someone might actually
hand to an employer is a correctness bug, not a cost optimization. Reject
with a clear "trim your resume below N characters" error instead.

### `tailored_resumes` — a new table, with RLS and grants extended explicitly

One row per (tenant, job). Ships as a new numbered migration,
`db/migrations/0XX_tailored_resumes.sql` — **not** as an edit to
`db/schema.sql`, which is already stale relative to production (it lacks
`tenant_id` on `app_settings`, lacks RLS, lacks `usage_counters` and
`tenant_api_keys`, and would resurrect `insights_cache`, a table
`006_drop_insights.sql` deliberately dropped). This is the same reason
`008_never_live.sql` bypassed `db/apply-schema.mjs` entirely; the numbered
migration path, run through `db/migrate.mjs`, is the only one that's safe
against an existing production database.

```sql
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

`job_id references jobs(id)` alone (not a composite `(tenant_id, job_id)`
FK) is sufficient: `jobs.id` is a globally unique UUID PK, and with RLS in
place, every read that assembles tailoring input is itself tenant-scoped
and will find nothing for a `job_id` outside the caller's own tenant even
if one were somehow supplied. The `unique (tenant_id, job_id)` constraint
is what makes "regenerating overwrites the row" a real `on conflict
(tenant_id, job_id) do update` upsert rather than a hand-rolled
delete-then-insert — the same shape `upsertSetting` (`lib/settings-store.ts`)
and the `watchlist_tenant_company_key` constraint (migration 001) already
use elsewhere.

**RLS is opt-in per table in this codebase and does not follow a new table
automatically.** `003_rls.sql` enables and forces RLS on a hardcoded array
of table names. A `tailored_resumes` table created without touching that
policy set would have **zero** row-level protection.

**The explicit `grant` is not redundant with `003_rls.sql`'s default
privileges.** `003_rls.sql` runs `alter default privileges ... grant ...
to app_rw` for future tables, but this codebase's own actual precedent for
"new table created after that point" — `004_metering.sql`, which creates
`usage_counters` and `usage_events` — grants explicitly anyway rather than
relying on the default-privileges clause alone. `tailored_resumes` follows
that precedent rather than assuming the earlier default still applies;
whether it would have worked without the explicit grant is not something
worth finding out by shipping it and getting "permission denied for table"
in production.

**`tailored_resumes` must be added to `TENANT_TABLES` in
`lib/supabase.ts` as an explicit step, not left to be caught by the
existing guard.** `lib/supabase.test.ts` pins a `TENANT_TABLES` list
against every tenant-scoped table, but its regex only matches the `alter
table ... add column if not exists tenant_id` retrofit pattern migrations
001/002 use — a table with `tenant_id` declared inline in `create table`,
which is what `tailored_resumes` does, will never be caught by that regex.
The guard test would stay green even if the addition to `TENANT_TABLES`
were forgotten. This doesn't create a tenant-isolation gap on its own
(RLS's `FORCE ROW LEVEL SECURITY` still fails closed with the table
absent from that list — see "Deploy and rollout" for how this is
verified), but it does mean whatever purpose `TENANT_TABLES` serves
elsewhere in the app silently excludes this table unless someone adds it
by hand.

## Tailoring call

`tailorResumeForJob(jobId: string)` in `app/actions/resume.ts`:

1. `requireResumeAdmin()`.
2. Load the tenant's `base_resume` (repaired via `resolveBaseResume`) and
   the target `jobs` row, tenant-scoped. **If the base resume has never
   been saved** — no summary and no work history entries — refuse before
   spending any budget, with a message pointing the user at the base
   resume editor. This mirrors `emptyBrainRefusal` (`app/actions/parse-role.ts`):
   the codebase's established position that scoring or generating against
   nothing produces silent wrongness, not a helpful empty result, and the
   failure mode this app consistently prefers is to fail loudly instead.
   **The job side never needs an equivalent refusal**: `company` and
   `role_title` are `not null` in `db/schema.sql`, so there is always
   something to tailor toward even when every other job field is empty.
3. Build a tailoring prompt from the base resume plus whichever of the
   job's stored summary fields are present (`key_skills`, `fit_summary`,
   `seniority`, `department`, `salary_range`, `company_description` are
   all nullable) via a pure builder in `lib/resume-prompt.ts`. A missing
   field **omits its block entirely** from the prompt rather than
   rendering an empty or null placeholder — the same convention
   `lib/fit-prompt.ts` already uses for `titleScope`/`domainBonus`, which
   omit their whole block when the underlying value is `""`. The builder
   is pinned by a checked-in fixture the same way `lib/fit-prompt.ts` is.
   This fixture ceremony is cheaper here than the justification behind the
   fit-prompt fixtures (those exist partly because that prompt affects
   every tenant's scoring and had to be proven byte-identical across a
   migration; neither applies to a single-owner, on-demand call) — it's
   included anyway as low-cost regression insurance on a paid model call
   whose prompt correctness isn't easy to verify by inspection, not
   because the precedent demands it.
4. Call it through **`withBudget()`** (`lib/metered.ts`) wrapping the
   actual model call — not a bare `callStructured()` call. `scoreFit`
   (`app/actions/parse-role.ts`) is the model for this: it wraps its model
   call in `withBudget({ ..., fn: () => scoreFitInner(opts) })`, which
   resolves the tenant's key/provider, enforces the daily/monthly budget
   ceiling, and only then runs `runWithBilling()` around the call itself.
   Calling `callStructured()` directly instead would silently bypass both
   budget enforcement and usage recording — this is not a stylistic
   preference, it's the difference between metered and unmetered spend.
5. **What the model is allowed to change, enforced programmatically, not
   just by prompt instruction.** The model is asked to return a full
   `TailoredResume` (same shape as `BaseResume`), but the result is
   validated against the input base resume before it's ever stored or
   shown:
   - `contact` and `education` must be exactly equal to the base resume's
     values. If the model changed them anyway, the base resume's original
     values are substituted back in before saving.
   - `skills` must be a reordering of the same set — same elements, any
     order. If the model added, dropped, or altered an element, the base
     resume's original skill order is substituted back in.
   - `workHistory` must have the same entries, in the same order, matched
     by `id` — same `company`/`title`/`startDate`/`endDate` for every
     entry. Only `bullets` within each entry may differ. Any entry that
     fails this check has its non-`bullets` fields restored from the base
     resume.
   This is what makes "without fabricating experience" a property the
   system enforces rather than a hope the prompt expresses — a model that
   ignores instructions and invents a job title still can't get it saved.
6. Upsert the validated result into `tailored_resumes` on
   `(tenant_id, job_id)`.

`getBaseResume()`, `saveBaseResume(data)`, `getTailoredResume(jobId)`, and
`bootstrapFromOnboarding()` round out `app/actions/resume.ts`.
`bootstrapFromOnboarding()` is opt-in and conditional: if
`profile.answers.resume` (the raw pasted résumé text captured at
résumé-mode onboarding, `lib/profile.ts`) is non-empty, one Claude
extraction call turns it into a `BaseResume` draft — passed through
`resolveBaseResume` before being shown, per the data-model section above —
which the user reviews and edits before saving. Nothing is written
automatically. Question-mode onboarders have no such text and start from a
blank form; this is convenience, not a dependency, and the rest of the
feature works identically either way.

## UI entry points

**`/resume`** is the base-resume editor: contact fields, a summary
textarea, repeatable work-history entries (add / remove / reorder, each
with company, title, dates, and a repeatable bullet list), repeatable
education entries, and a repeatable skills list. If `base_resume` has
never been saved and `profile.answers.resume` is non-empty, the empty
form shows a "Prefill from my onboarding résumé" button that calls
`bootstrapFromOnboarding()`. Saving over a **non-empty** existing base
resume asks for confirmation first (see "Overwrite safety" below).

**Tailoring is triggered from the Roles table, not from `/resume`
directly.** Each row in `RolesTable` gets a "Tailor resume" button,
rendered only when `isAdmin` (passed down the same way the nav's admin-only
entries already are — no new client-side check invented). It links to
`/resume?jobId=<job.id>`. When `/resume` is opened with that query param,
it additionally shows: the target job's title and company for context; a
"Tailor for this job" button that calls `tailorResumeForJob(jobId)`; and,
once a tailored resume exists for that job (loaded via
`getTailoredResume(jobId)` on page load, whether freshly generated or from
a previous visit), the rendered result with "Print / Export PDF"
(`window.print()`) and "Regenerate" buttons. Regenerating an
already-existing tailored resume for that job also confirms first.

**Overwrite safety.** Neither `saveBaseResume` nor a tailoring regenerate
is undoable — "no version history" (Scope for v1) means a bad result
replaces a good one with nothing to fall back to. Full versioning was
rejected as overbuilt for a single-user v1, but doing nothing about it
was rejected too: the cheap middle ground is a confirmation prompt before
either destructive write — a plain `window.confirm()`-level interaction,
not a modal component or an undo stack — whenever the write would replace
non-empty prior content. This is the whole mitigation; it's intentionally
not more than that.

## Rendering and export

The Claude Design project named "Resume design system"
(`697a0eb1-…`) — a project, not one of the account's formal Design System
objects — already contains a finished set of résumé design assets built
from the tenant's actual résumé PDF: type and color tokens, six components
(`ResumeHeader`, `RoleEntry`, `SystemsBlock`, `TagList`, `SectionTitle`,
`CompressedRoles`), 19 style guideline specimens, and four finished résumé
variants differing only in emphasis, not visual style — `index.html` ("the
default send," a blended mix across the tenant's GTM/RevOps, product, and
AI-systems-building experience), `resume-gtm.html`, `resume-product.html`,
and `resume-ai.html`.
**v1 ships `index.html`** — the balanced variant is the safest shell for a
tailoring pass that has to adapt toward an unknown range of job types,
rather than one already pre-angled toward a single career bucket.

Per the `claude-design-handoff` skill, what this project holds is a spec
plus a prototype, not production code: `index.html`'s markup and the
token files are mined for structure and values and hand-reimplemented
into this repo's own styling conventions as a React component in
`components/resume/`, taking a `BaseResume | TailoredResume` as props —
not a literal import of the exported file. The project's own `readme.md`
and `SKILL.md` (a "portable version for Claude Code") are the source of
truth for the exact type scale, color tokens, and print-layout rules to
carry over.

Export is `window.print()` behind the component's `@media print`
stylesheet — no PDF library, no server-side rendering. Because nothing in
the design/handoff process validates print pagination, the template needs
an explicit validation pass after handoff: page breaks landing mid-entry,
margins, and multi-page overflow have to be checked by actually printing
(or print-previewing) a resume with enough content to span more than one
page, not assumed to fall out of how the template looks on screen. The
design's own readme already states a target (two Letter pages at 0.7in
margins, ≈1,842px of usable flow) — the validation pass confirms the
hand-reimplementation actually hits it.

## Testing

- `resolveBaseResume` — pure repair function, unit tested the way
  `resolveProfile` is: malformed/missing fields fall back field-by-field,
  never object-wide; missing `id`s on repeatable entries are backfilled;
  returned values are always fresh, never a shared reference. The same
  test coverage is what backs `bootstrapFromOnboarding()`'s extraction
  path, since its output is piped through this function before display —
  no separate test is needed for that call site.
- A dedicated test pinning that a non-admin actor is refused by `/resume`
  and by every `resume.ts` export — mirroring how `lib/auth-policy.test.ts`
  guards this app's other auth invariants. This is the one genuinely new
  invariant the feature adds; `auth-required.test.ts`'s existing blanket
  session-less-call check passes regardless of whether the `isAdmin` gate
  is even present, so it cannot be relied on to catch a missing or broken
  admin check on its own.
- A fixture test for the tailoring prompt builder in `lib/resume-prompt.ts`,
  same pattern as `lib/__fixtures__/fit-prompt.*.txt` — see the
  justification in "Tailoring call" step 3 for why this is worth doing
  despite the weaker case than `fit-prompt.ts`'s own.
- A unit test for the post-call validation logic in step 5 of "Tailoring
  call": given a model response that alters contact info, reorders/drops a
  skill, or changes a work-history entry's company/title/dates, the
  validated result matches the base resume for every field except the
  bullets the model was actually allowed to touch.
- Migration correctness (the `create table`, RLS policy, and grant) isn't
  unit-testable in this codebase's suite — `npm test` covers pure logic
  only, per CLAUDE.md — so it's verified against the live database
  directly, per "Deploy and rollout" below, the same way `012_watchlist_signal.sql`
  was verified in production rather than assumed correct from the SQL
  alone. The upsert-on-regenerate behavior (`on conflict (tenant_id,
  job_id) do update`) is verified the same way: call `tailorResumeForJob`
  twice against the same job in the running app and confirm one row with
  updated `content`/`generated_at`, not a second row — this needs a live
  database and isn't a `vitest` case either.

## Deploy and rollout

Mirrors `2026-08-17-never-live-roles-design.md`'s "deploy order is
load-bearing" — a new table with RLS from scratch is higher-stakes than
most of this app's prior migrations, which extended existing tables, so it
gets its own explicit order rather than an implicit "run it and see":

1. Run the new migration first, against the live Railway Postgres, and
   confirm — not assume — the following before any application code
   depends on it: `tailored_resumes` exists with the stated columns and
   the `unique (tenant_id, job_id)` constraint; `force row level security`
   is on; and a manual query with `app.tenant_id` unset returns zero rows
   / is rejected, while a query with it set to a real tenant id returns
   only that tenant's rows.
2. Add `tailored_resumes` to `TENANT_TABLES` in `lib/supabase.ts` and run
   `lib/supabase.test.ts` to confirm the guard passes with it explicitly
   present — not because the regex happened to match, but because it's
   actually listed.
3. Push to `main`. Verify the deployed commit's `commitHash`
   (`railway deployment list --service web --limit 1 --json`) matches
   `git rev-parse main`, per this repo's standing verification rule —
   don't trust that a push shipped without checking.
4. Confirm gating end-to-end as the app owner: `/resume` renders, the nav
   entry appears, and the "Tailor resume" button appears on `/roles` rows.
   If a second, non-admin test account is available, confirm `/resume`
   redirects to `/discover` for it and no resume-related button or nav
   entry is present.
5. Run one real tailoring pass against a real tracked job and confirm the
   spend shows up in the admin budget overview the same way a `scoreFit`
   call already does — this is the end-to-end proof that `withBudget()` is
   actually wired in, not just described in this spec.

## Non-goals (restated)

Re-fetching full posting text; multiple base resumes or tailored-resume
history (mitigated instead by confirm-before-overwrite, not solved); a
choice of templates (one of the four existing variants, `index.html`,
ships); server-rendered PDF. See "Scope for v1" above for why each is
deferred rather than simply forgotten.
