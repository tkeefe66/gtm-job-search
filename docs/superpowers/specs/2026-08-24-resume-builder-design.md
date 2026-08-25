# AI-tailored resume builder — design, revision 4

Date: 2026-08-24
Status: approved for planning

Revision 1 was reviewed by three independent subagents, each against a
different lens (technical correctness, adversarial tenant-isolation
security, and scope/completeness). No security gap survived review, but two
factual errors and a set of real scope gaps did. Revision 2 fixed them.

**Revision 3: the Claude Design project revision 2 pointed at was itself the
wrong one.** `697a0eb1-…` ("Resume design system," teal/clay, Source Sans 3 +
IBM Plex Mono) was a different, earlier project. The next one tried,
`6546d121-…` ("My Resume Design System," an editorial broadsheet in
Newsreader + JetBrains Mono with a navy accent), was ported into the repo and
verified in a browser — described in revision 3 as done. It, too, turned out
to be the wrong source.

**Revision 4: the actually-correct source is a different kind of object
entirely.** `999f7fe8-e8bc-449f-9121-0f2d8dc9730c`, "TK Resume Design
System," is a formal Claude Design **Design System** object
(`type: "PROJECT_TYPE_DESIGN_SYSTEM"`) — not a "project" like the two before
it. Visually it's the same broadsheet identity (Newsreader + JetBrains Mono,
navy `oklch(0.345 0.085 258)`), more refined, but structurally it is not a
static template at all: it ships `render.js`, a pure, dependency-free
tailoring engine (`selectBullets`/`renderBody`/`renderResume`/`coverage`)
plus `content/resume.json` — the tenant's real career record, 12 roles, every
bullet pre-tagged with a `priority` and a set of `themes` — and
`content/themes.json`, the job-description-signal vocabulary used to derive
which themes apply to a given posting. This **replaces the entire tailoring
design** the earlier revisions built: instead of an LLM freely rewriting a
resume and a post-hoc check trying to catch fabrication, the LLM's only job
is to derive `themes: string[]` from a job posting — a deterministic
function then *selects* bullets from a fixed, pre-approved pool. Fabrication
becomes structurally impossible instead of something to validate against.
It also settles a question the earlier revisions didn't ask: this career
data is single-owner, already checked into the repo, and already mirrored
from the tenant's own `tkeefe66/my-resume` GitHub repo — so per revision 4
it is treated as static application content, not a per-tenant database row
edited through a web form. This removes the entire base-resume editor,
`saveBaseResume`, `bootstrapFromOnboarding`, and `resolveBaseResume` from
the design outright — not deferred, decided against. See "What changed from
revision 3" below for the full list, and "Data model" / "Tailoring call" /
"UI entry points" / "Rendering and export", all rewritten in this revision.

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
- **The `resume.ts` actions share one gate function**, not hand-written
  copies of the same two-line check — the exact failure mode
  `auth-required.test.ts`'s own doc comment names ("a hand-written check is
  one someone forgets when adding the 37th [action]").
- **`tailored_resumes` is called out by name** as needing a manual addition
  to `TENANT_TABLES` in `lib/supabase.ts`, because the regression guard
  that's supposed to catch a missed tenant-scoped table only matches the
  `alter table ... add column` retrofit pattern, not an inline
  `create table` with `tenant_id` baked in — it would stay green even if
  the addition were forgotten.
- **A UI entry-point section is added.** Revision 1 specified server
  actions and no caller for most of them. It now says exactly where in the
  app each one is invoked from.
- **Empty/missing-input behavior is now defined** for a job with sparse
  stored fields (omit the block, never refuse — `jobs.company`/`role_title`
  are the only fields guaranteed non-null, so there's always something to
  tailor from).
- **A deploy/rollout section is added**, matching the rigor of
  `2026-08-17-never-live-roles-design.md`'s "Deploy order is load-bearing"
  section rather than the vaguer "should be checked manually" revision 1
  had.

*(Revision 2 also added `saveBaseResume` size validation, a defined
`TailoredResume` type with a post-call anti-fabrication check, `id` fields
on repeatable entries, and an overwrite-safety confirm. All of that applied
to the per-tenant editable base resume revision 4 removes — see below. It's
left out of this list rather than kept and re-marked stale, since none of
it survives into the current design.)*

## What changed from revision 3

- **The design source was wrong again** — see the revision-4 note at the
  top. The real object is a formal Design System, not a project, and its
  actual content model (`render.js` + `content/resume.json` +
  `content/themes.json`) is materially different from what revision 3
  ported.
- **Tailoring is no longer free-text LLM rewriting.** `lib/resume-render/render.js`'s
  `selectBullets(career, {themes})` picks bullets from a pre-tagged,
  pre-approved pool; the LLM's only job is producing the `themes: string[]`
  input. The entire "what the model is allowed to change, enforced
  programmatically" anti-fabrication section from revision 2/3 is gone —
  not hardened further, *removed*, because the problem it solved can no
  longer occur.
- **There is no more base resume to store, edit, or bootstrap.** The career
  record is `lib/resume-render/content/resume.json`, already committed to
  this repo, maintained by hand or synced from `tkeefe66/my-resume` — not
  an `app_settings` row, not edited through `/resume`. This removes
  `getBaseResume`, `saveBaseResume`, `bootstrapFromOnboarding`,
  `resolveBaseResume`, the base-resume editor UI, and the "confirm before
  overwriting a non-empty base resume" mitigation — none of it has
  anything left to apply to.
- **`tailored_resumes.content` now stores a small selection, not a full
  resume document** — `{ themes: string[], selection: ResumeSelection }`
  (a positioning id plus a compact role-id → bullet-id list), because
  `renderBody()` regenerates the actual markup from `content/resume.json`
  plus this selection on every read. There's no duplicated résumé text
  sitting in the database at all.
- **The template port is real, committed code**, not a plan: `lib/resume-render/render.js`
  (vendored, byte-verified), `components/resume/ResumeDocument.tsx`
  (calls `renderBody()` rather than hand-authoring `.rsm` markup, so it
  cannot drift from the design system's own class contract), and the
  design assets in `public/resume-design/`. See "Rendering and export."

## The problem

The app finds and scores roles well but does nothing with the output: once
a role clears the fit bar, the user still writes a resume for it by hand,
outside the app, from scratch every time. This adds a resume builder that
starts from the tenant's own career record — already checked into the app —
and produces a resume tailored to a specific tracked job on demand, by
deriving which of the record's pre-approved bullets are most relevant and
letting the design system's own deterministic engine select and render
them, exported by printing to PDF.

This is a single-owner feature bolted onto a public, multi-tenant app. The
hard constraint is not "build a resume builder" — it's "build a resume
builder that is invisible and inert for every tenant except the app owner,"
because every other design decision downstream has to satisfy that first.

## Scope for v1

**In scope**: the checked-in career record and theme vocabulary
(`lib/resume-render/content/{resume,themes}.json`, already ported); the
already-ported rendering engine and template (`lib/resume-render/render.js`,
`components/resume/ResumeDocument.tsx` — see "Rendering and export"); an AI
tailoring pass per tracked job that derives relevant `themes` from the
job's stored fields and lets `selectBullets()` pick from the pre-tagged
bullet pool (never generates new résumé text); PDF export via browser
print (already working).

**Out of scope, named explicitly rather than left implicit**:

- **Re-fetching the full job posting.** `jobs` (`db/schema.sql`) stores
  only structured summary fields — `role_title`, `key_skills`,
  `fit_summary`, `seniority`, `department`, `salary_range`,
  `company_description` — never the posting's full text. Theme derivation
  in v1 works from those fields only. This is a real, deliberate quality
  ceiling: deriving themes with no job-description language to match
  against will read as generic. The natural v1.1 upgrade is to reuse the
  crawler's existing fetch-and-strip path (`lib/page-extract.ts`) at
  tailor time — deferred because that path is already fighting link rot
  hard (`repairJobLinks`, `never_live`, "Posting Closed"), and a live
  re-fetch would frequently fail for exactly the older postings a user
  most wants to tailor against. If theme derivation quality disappoints in
  practice, this is where to look first.
- **A web-based editor for the career record.** Decided against, not
  deferred: `content/resume.json` is maintained by hand or synced from
  `tkeefe66/my-resume`, not through the app. See the revision-4 note at
  the top.
- Version history of past tailored resumes. Regenerating a tailored
  resume for a job overwrites the previous selection (see "Overwrite
  safety" below for the cheap mitigation this still gets).
- **A manual positioning override.** `render.js`'s `SelectBulletsOptions.positioning`
  can force a specific variant (`blended`/`gtm`/`product`/`ai`), but v1
  never sets it — tailoring always lets the best theme match decide. No
  dropdown letting the user force a positioning by hand.
- **Surfacing `coverage()`'s match-quality report.** `render.js` exposes a
  `coverage()` function that can report which themes are strongly/thinly/
  not covered by the résumé's bullet pool for a given job — a genuinely
  useful signal, left unused in v1 rather than building UI around it ahead
  of need.
- Server-rendered PDF. Export is `window.print()` behind a print
  stylesheet — no PDF library, no server-side rendering path.

The old "choice of templates" non-goal from revisions 2–3 no longer applies
as a separate decision: the four emphasis variants (blended/GTM/product/AI)
are `positioning[]` entries inside the one canonical `resume.json`, not
separate files to pick between, and tailoring already picks the
best-matching one automatically via theme matching.

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

**One shared gate function.** `requireResumeAdmin()` in `app/actions/resume.ts`
— a small wrapper mirroring `requireAdmin()` in `app/actions/admin.ts`
exactly (`requireActor()` then `if (!actor.isAdmin) throw`) — is the first
statement in both of the module's exported actions (`tailorResumeForJob`,
`getTailoredResume` — down from revision 2's five now that there's no
base-resume CRUD). Two call sites is a small surface, but a shared function
costs nothing and is still the right habit: it's the same failure mode
`auth-required.test.ts`'s own doc comment warns about, at whatever count.

**Page gate**: `/resume`'s `page.tsx` calls `requireActorPage()` as every
page does, then checks `actor.isAdmin` and redirects to `/discover` if
false — the same shape `app/admin/page.tsx` already uses. A redirect, not a
distinctive refusal page, is what makes the route actually inert rather
than merely blocked: a refusal that renders differently from a 404 still
confirms the route exists.

**Action gate**: both exports in the new `app/actions/resume.ts` call
`requireResumeAdmin()`, which itself calls `requireActor()` first
(satisfying `auth-required.test.ts`'s blanket session-less-call check, same
as every other action file) before checking `actor.isAdmin`.

**Nav / entry-point gate**: both the `/resume` nav link and the
per-row "Tailor resume" button on `/roles` (see "UI entry points" below)
render only when the server-rendered `actor.isAdmin` is true, passed down
from the same server-component source the nav already reads — no new
client-side check is invented.

## Data model

### The career record — checked-in content, not a database row

`lib/resume-render/content/resume.json` (typed as `CareerRecord` in
`lib/resume-render/render.d.ts`) is the tenant's whole career record: name
and contact links, four `positioning` variants (each with its own theme
set, tagline, and summary), 12 `roles` (each with a full bullet pool —
`{ id, priority, themes, text }` per bullet), a `compressed` list for the
earliest roles that render as single lines regardless of content,
`advisory` and `education` rows, and `rules` (the taper array controlling
how many bullets each role can show, which themes exist, and
`compressAfter`, the role index past which entries always compress).
`content/themes.json` (`ThemeVocabulary`) is the parallel job-description
vocabulary — each theme's id, label, the phrase patterns
(`jdSignals`) that indicate it, and known gaps.

Both files are committed to this repo, already ported and byte-verified
against the Claude Design source (see "Rendering and export"). Neither is
an `app_settings` row, and neither is edited through the app — see the
revision-4 note at the top for why. Consequently there is no
`resolveBaseResume`-style repair function and no write-time size
validation for this data: it isn't runtime user input, it's committed,
type-checked (via `render.d.ts`) application content, maintained the same
way `DEFAULT_PROFILE` or any other shipped constant in this codebase is.

```ts
// lib/resume-render/render.d.ts (already committed; summarized here)
interface ResumeBullet { id: string; priority: number; themes: string[]; text: string }
interface ResumeRole {
  id: string; title: string; org: string; scope?: string; acquired?: string;
  dates: string; accounts?: string[]; bullets: ResumeBullet[];
}
interface ResumeRow { main: string; scope?: string; dates?: string }
interface PositioningVariant { id: string; themes: string[]; tagline: string; summary: string }
interface CareerRules {
  taper: number[]; themes: string[]; compressAfter: number | null; notes?: string;
}
interface CareerRecord {
  identity: { name: string; contacts: { label: string; href?: string }[] };
  positioning: PositioningVariant[];
  roles: ResumeRole[];
  compressed?: ResumeRow[];
  advisory: ResumeRow[];
  education: ResumeRow[];
  rules: CareerRules;
}

interface ResumeSelection {
  positioningId: string | null;
  bullets: Record<string, string[]>; // roleId -> ordered bullet ids
}
```

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

`content` stores `{ themes: string[], selection: ResumeSelection }` — the
derived themes (for debugging/auditing what drove the selection) and the
compact selection itself. It is deliberately **not** a full rendered résumé
document: `ResumeDocument` calls `renderBody(career, selection)` against the
live, checked-in `content/resume.json` on every read, so nothing about the
actual résumé text is duplicated into the database. This is smaller and
simpler than what revisions 2–3 specified, a direct consequence of
tailoring no longer being free-text generation.

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
2. Load the target `jobs` row, tenant-scoped. `company` and `role_title`
   are `not null` in `db/schema.sql`, so there is always something to
   derive themes from even when every other job field is empty — no
   empty-input refusal is needed on this side (there's no base-resume
   side left to refuse on either, since it's always present as checked-in
   content).
3. Build a **theme-derivation** prompt from whichever of the job's stored
   summary fields are present (`key_skills`, `fit_summary`, `seniority`,
   `department`, `salary_range`, `company_description` are all nullable)
   plus `content/themes.json`'s vocabulary (each theme's `jdSignals`), via
   a pure builder in `lib/resume-prompt.ts`. This is a small classification
   task — "which of these 8 named themes does this posting call for,
   ranked" — not open-ended generation, which is what makes the rest of
   this pipeline safe: the model picks from a fixed vocabulary, same as it
   picks from a fixed bullet pool one step later. A missing job field
   **omits its block entirely** from the prompt rather than rendering an
   empty or null placeholder — the same convention `lib/fit-prompt.ts`
   already uses for `titleScope`/`domainBonus`. The builder is pinned by a
   checked-in fixture the same way `lib/fit-prompt.ts` is — cheap
   regression insurance on a paid model call, same reasoning as before,
   now for an even smaller prompt.
4. Call it through **`withBudget()`** (`lib/metered.ts`) wrapping the
   actual model call — not a bare `callStructured()` call. `scoreFit`
   (`app/actions/parse-role.ts`) is the model for this: it wraps its model
   call in `withBudget({ ..., fn: () => scoreFitInner(opts) })`, which
   resolves the tenant's key/provider, enforces the daily/monthly budget
   ceiling, and only then runs `runWithBilling()` around the call itself.
   Calling `callStructured()` directly instead would silently bypass both
   budget enforcement and usage recording.
5. Call `selectBullets(career, { themes })` (`lib/resume-render/render.js`
   — a pure, deterministic function, not a model call) with the derived
   theme list. This is the step that replaces revision 2/3's whole
   post-call anti-fabrication validation: `selectBullets` can only return
   bullet ids that already exist in `content/resume.json`'s pool, so there
   is nothing for the model to fabricate — it never sees or produces résumé
   prose at all, only theme labels.
6. Upsert `{ themes, selection }` into `tailored_resumes` on
   `(tenant_id, job_id)`.

`getTailoredResume(jobId)` rounds out `app/actions/resume.ts`: loads the
stored `{ themes, selection }` for a job, tenant-scoped, returning `null`
if none exists yet (never generated, or the job was deleted) — the caller
renders an empty/"not yet tailored" state rather than treating that as an
error.

## UI entry points

**Tailoring is triggered from the Roles table.** Each row in `RolesTable`
gets a "Tailor resume" button, rendered only when `isAdmin` (passed down
the same way the nav's admin-only entries already are — no new
client-side check invented). It links to `/resume?jobId=<job.id>`.

**`/resume` has no standalone content of its own** — there's no base
resume left to edit (see "What changed from revision 3"). Visited without
a `jobId`, it shows a short pointer back to `/roles` ("tailor a resume from
a tracked role"). Visited as `/resume?jobId=<id>`, it shows: the target
job's title and company for context; a "Tailor for this job" button that
calls `tailorResumeForJob(jobId)`; and, once a selection exists for that
job (loaded via `getTailoredResume(jobId)` on page load, whether freshly
generated or from a previous visit), the rendered result — `ResumeDocument`
calling `renderBody(career, selection)` — with "Print / Export PDF"
(`window.print()`) and "Regenerate" buttons.

**Overwrite safety.** Regenerating an existing tailored resume for a job
is not undoable — "no version history" (Scope for v1) means a new
selection replaces the old one with nothing to fall back to. Full
versioning was rejected as overbuilt for a single-user v1, but doing
nothing about it was rejected too: "Regenerate" confirms first — a plain
`window.confirm()`-level interaction, not a modal component or an undo
stack. This is the whole mitigation; it's intentionally not more than
that. (Revision 2/3's parallel concern about overwriting a *base* resume no
longer applies — there's no base resume left to overwrite through the app.)

## Rendering and export

**This section describes work that is already done, not proposed.** The
correct Claude Design source is `999f7fe8-e8bc-449f-9121-0f2d8dc9730c`, "TK
Resume Design System" — a formal Design System object
(`type: "PROJECT_TYPE_DESIGN_SYSTEM"`), not a project like the two earlier,
wrong sources. Visually: an editorial broadsheet in **Newsreader** (variable
serif) and **JetBrains Mono**, single deep-navy accent
(`oklch(0.345 0.085 258)`), a 52→17→14→10 type scale, a 96px section rail,
oldstyle proportional figures — a more refined version of what revision 3
ported, built from the tenant's actual résumé. Structurally, it is not a
static template: it ships a real tailoring engine.

- **`lib/resume-render/render.js`** — vendored verbatim, byte-verified
  against the source. Pure JS, no dependencies. Exposes `selectBullets`,
  `renderBody` (the `.rsm` div only, for embedding), `renderResume` (a
  complete print-ready document), and `coverage` (match-quality reporting,
  unused in v1 — see "Scope for v1"). `render.d.ts` adds TypeScript types
  since the file itself is untyped JS. **This file owns the `.rsm` markup
  contract outright** — the design system's own docs are explicit these
  functions are meant to be called from a consuming application, not
  reimplemented, the same "drops into any project" intent revision 3's
  source stated, now backed by an actual API instead of a static file to
  mine values from.
- **`public/resume-design/`** — `styles.css`, the `tokens/*.css` files (now
  including `elevation.css`), `doc-page.js`, and `page-guides.js`, copied
  near-verbatim and byte-verified. `doc-page.js` is **byte-identical** to
  the version ported from the wrong `6546d121` source in revision 3 — it's
  a shared, versioned starter component across Claude Design projects, not
  something regenerated per-project, so that part of the earlier port
  turned out to be correct despite the wrong project overall.
  `page-guides.js` was updated upstream (a rail-anchored page-2 label
  instead of a right-edge one).
- **`components/resume/ResumeDocument.tsx`** — rewritten to call
  `renderBody(career, selection)` and mount the result via
  `dangerouslySetInnerHTML` inside the `<doc-page>` custom element, rather
  than hand-authoring `.rsm`-scoped JSX the way revision 3's version did.
  This is a meaningful correctness improvement, not just a refactor: the
  component can no longer drift from the design system's own markup
  contract, because it no longer has its own opinion about that markup —
  `render.js` is the only place `.rsm` structure is defined. Omitting
  `selection` renders every bullet in every role, unfiltered — useful for
  a full-content preview.
- **A temporary, admin-gated preview route**, `app/resume-preview/page.tsx`
  (reusing the existing `requireAdminPage()` — no new gating mechanism),
  calls `selectBullets` against the real `content/resume.json` with the
  "blended" positioning and renders the result. This route exists only to
  verify the port; it is **not** the real `/resume` route "UI entry points"
  describes, and gets deleted once that route exists.

Export is `window.print()` — `<doc-page>` owns the print geometry entirely;
nothing else writes `@page` rules or page-break CSS. No PDF library, no
server-side rendering. Verified directly: `doc-page.js`'s custom element
registered with zero console errors, the visual identity (fonts, accent,
type scale) rendered correctly, `@page` print geometry was confirmed
injected, and the compressed-row merge behavior was confirmed genuinely
running the selection logic (three real early-career titles collapsing
into one row), not just static markup. Since the live `/resume-preview`
route needs a database connection and a real admin session neither
available in the environment that built this, verification used a static
harness driving the actual ported `render.js`/`doc-page.js`/`page-guides.js`
files directly rather than the full Next.js route — the harder, riskier
layer (the vendored assets) was checked; confirming the live gated route
itself is still open and worth doing directly.

**One disclosed, accepted gap**: `content/resume.json` and
`content/themes.json` are each exactly 1 byte over their source sizes after
reconciling HTML-entity-escaping and typographic-quote handling during the
fetch — every other fetched file (`render.js`, all CSS, `page-guides.js`)
is byte-exact. Both JSON files were confirmed structurally and semantically
faithful (correct rendering in the browser check, including a
double-escaping edge case in role titles that renders correctly as a
literal `&` rather than a stray escape sequence), so this is recorded as a
known, checked discrepancy rather than presented as byte-exact when it
isn't.

## Testing

- A dedicated test pinning that a non-admin actor is refused by `/resume`
  and by both `resume.ts` exports — mirroring how `lib/auth-policy.test.ts`
  guards this app's other auth invariants. This is the one genuinely new
  invariant the feature adds; `auth-required.test.ts`'s existing blanket
  session-less-call check passes regardless of whether the `isAdmin` gate
  is even present, so it cannot be relied on to catch a missing or broken
  admin check on its own.
- A fixture test for the theme-derivation prompt builder in
  `lib/resume-prompt.ts`, same pattern as `lib/__fixtures__/fit-prompt.*.txt`
  — cheap regression insurance on a paid model call whose prompt
  correctness isn't easy to verify by inspection.
- `render.js`'s own functions (`selectBullets`/`renderBody`/`coverage`) are
  vendored, byte-verified code from the design system, not authored by
  this app, and are not re-tested here — the design system is where their
  correctness is owned. What this app *does* need its own test for is the
  pipeline built around them: given a derived `themes` list (including
  edge cases — empty, containing a theme id not present in
  `content/themes.json`), `selectBullets` + `renderBody` produce
  non-crashing, non-empty HTML. This is a smoke test on integration, not a
  correctness test on the vendored logic.
- Migration correctness (the `create table`, RLS policy, and grant) isn't
  unit-testable in this codebase's suite — `npm test` covers pure logic
  only, per CLAUDE.md — so it's verified against the live database
  directly, per "Deploy and rollout" below, the same way
  `012_watchlist_signal.sql` was verified in production rather than
  assumed correct from the SQL alone. The upsert-on-regenerate behavior
  (`on conflict (tenant_id, job_id) do update`) is verified the same way:
  call `tailorResumeForJob` twice against the same job in the running app
  and confirm one row with updated `content`/`generated_at`, not a second
  row — this needs a live database and isn't a `vitest` case either.

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
4. Confirm gating end-to-end as the app owner: `/resume` renders (with and
   without a `jobId`), the nav entry appears, and the "Tailor resume"
   button appears on `/roles` rows. If a second, non-admin test account is
   available, confirm `/resume` redirects to `/discover` for it and no
   resume-related button or nav entry is present.
5. Run one real tailoring pass against a real tracked job and confirm the
   spend shows up in the admin budget overview the same way a `scoreFit`
   call already does — this is the end-to-end proof that `withBudget()` is
   actually wired in, not just described in this spec.

## Non-goals (restated)

Re-fetching full posting text; a web-based editor for the career record
(the record is checked-in content, not a database row — see "What changed
from revision 3"); version history of past tailored resumes (mitigated
instead by confirm-before-regenerate, not solved); a manual positioning
override; surfacing `coverage()`'s match-quality report; server-rendered
PDF. See "Scope for v1" above for why each is deferred or decided against.
