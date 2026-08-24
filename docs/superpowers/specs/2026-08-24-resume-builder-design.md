# AI-tailored resume builder — design

Date: 2026-08-24
Status: approved for planning

## The problem

The app finds and scores roles well but does nothing with the output: once a
role clears the fit bar, the user still writes a resume for it by hand,
outside the app, from scratch every time. This adds a resume builder that
starts from one structured "base resume" the user maintains once, and
produces a resume tailored to a specific tracked job on demand, rendered
through a visually designed template and exported by printing to PDF.

This is a single-owner feature bolted onto a public, multi-tenant app. The
hard constraint is not "build a resume builder" — it's "build a resume
builder that is invisible and inert for every tenant except the app owner,"
because every other design decision downstream has to satisfy that first.

## Scope for v1

**In scope**: one structured base resume per tenant; one designed template;
an AI tailoring pass per tracked job that rewrites the summary and
reorders/re-emphasizes bullets; PDF export via browser print; an optional
one-time bootstrap from the résumé text captured at onboarding, for tenants
who onboarded that way.

**Out of scope, named explicitly rather than left implicit**:

- **Re-fetching the full job posting.** `jobs` (`db/schema.sql`) stores only
  structured summary fields — `role_title`, `key_skills`, `fit_summary`,
  `seniority`, `department`, `salary_range`, `company_description` — never
  the posting's full text. Tailoring in v1 works from those fields only.
  This is a real, deliberate quality ceiling, not a footnote: a tailoring
  pass with no job-description language to match against will read as
  competent reordering, not real keyword-matching. The natural v1.1 upgrade
  is to reuse the crawler's existing fetch-and-strip path
  (`lib/page-extract.ts`) at tailor time — deferred because that path is
  already fighting link rot hard (`repairJobLinks`, `never_live`, "Posting
  Closed"), and a live re-fetch would frequently fail for exactly the older
  postings a user most wants to tailor against. If tailoring quality
  disappoints in practice, this is where to look first.
- Multiple base resumes, or any version history of past tailored resumes.
  Regenerating a tailored resume for a job overwrites the previous one.
- A choice of templates. One designed template ships in v1.
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

**Page gate**: `/resume`'s `page.tsx` calls `requireActorPage()` as every
page does, then checks `actor.isAdmin` and redirects to `/discover` if
false — the same shape `requireActorPage()` itself uses for
`onboardingRedirect` (`lib/require-actor.ts`) when a tenant hasn't
onboarded. A redirect, not a distinctive refusal page, is what makes the
route actually inert rather than merely blocked: a refusal that renders
differently from a 404 still confirms the route exists.

**Action gate**: every export in the new `app/actions/resume.ts` calls
`requireActor()` (satisfying `auth-required.test.ts`'s blanket
session-less-call check, same as every other action file) and then checks
`actor.isAdmin`, refusing non-admin callers the same way `requireAdmin()`
does today.

**Nav gate**: the shell component that renders the app's nav only renders a
"Resume" link when the server-rendered `actor.isAdmin` is true — the same
conditional-render pattern already used for whatever admin-only nav entries
exist today, so a non-admin tenant's client bundle never even references the
route by name in a visible link.

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
  company: string;
  title: string;
  startDate: string; // free-form ("2021", "Mar 2021") — not parsed, only displayed
  endDate: string;   // "" or "Present" both valid
  bullets: string[];
}

interface EducationEntry {
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
```

None of `ResumeContact`'s fields exist anywhere in `Profile` today — this is
new surface area, not a relabeling of something onboarding already
collects.

`resolveBaseResume(raw: unknown): BaseResume` in `lib/resume.ts` mirrors
`resolveProfile()`: unknown/malformed input repairs field-by-field against
an all-empty default rather than being rejected, and every returned value
is fresh (never a reference into a shared default), matching the contract
`resolveProfile`'s own doc comment states and enforces.

### `tailored_resumes` — a new table, with RLS extended explicitly

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
```

`job_id references jobs(id)` alone (not a composite `(tenant_id, job_id)`
FK) is sufficient: `jobs.id` is a globally unique UUID PK, and once RLS
covers `tailored_resumes` (below), every read that assembles tailoring
input is itself tenant-scoped and will find nothing for a `job_id` outside
the caller's own tenant even if one were somehow supplied. The `unique
(tenant_id, job_id)` constraint is what makes "regenerating overwrites the
row" a real `on conflict (tenant_id, job_id) do update` upsert rather than
a hand-rolled delete-then-insert — the same shape `upsertSetting`
(`lib/settings-store.ts`) and the `watchlist_tenant_company_key` constraint
(migration 001) already use elsewhere.

**RLS is opt-in per table in this codebase and does not follow a new table
automatically.** `003_rls.sql` enables and forces RLS on a hardcoded array
of table names. A `tailored_resumes` table created without touching that
policy set would have **zero** row-level protection — reachable only by
whatever the app layer happens to filter, with no database-level backstop
if a query ever forgot a `WHERE tenant_id = ...` clause. The same migration
that creates the table must also extend `003_rls.sql`'s pattern for it:

```sql
alter table tailored_resumes enable row level security;
alter table tailored_resumes force row level security;

create policy tenant_isolation on tailored_resumes
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
```

## Tailoring call

`tailorResumeForJob(jobId: string)` in `app/actions/resume.ts`:

1. `requireActor()`, then check `actor.isAdmin` (refuse otherwise).
2. Load the tenant's `base_resume` (repaired via `resolveBaseResume`) and
   the target `jobs` row, tenant-scoped.
3. Build a tailoring prompt from the base resume plus the job's stored
   summary fields (`role_title`, `company`, `key_skills`, `fit_summary`,
   `seniority`, `department`, `salary_range`, `company_description`) via a
   pure builder in `lib/resume-prompt.ts`, pinned by a checked-in fixture
   the same way `lib/fit-prompt.ts` is — a rendered-prompt diff, not just a
   builder unit test, is what catches an unintended prompt change.
4. Call it through **`withBudget()`** (`lib/metered.ts`) wrapping the
   actual model call — not a bare `callStructured()` call. `scoreFit`
   (`app/actions/parse-role.ts`) is the model for this: it wraps its model
   call in `withBudget({ ..., fn: () => scoreFitInner(opts) })`, which
   resolves the tenant's key/provider, enforces the daily/monthly budget
   ceiling, and only then runs `runWithBilling()` around the call itself.
   Calling `callStructured()` directly instead would silently bypass both
   budget enforcement and usage recording — this is not a stylistic
   preference, it's the difference between metered and unmetered spend.
5. Upsert the result into `tailored_resumes` on `(tenant_id, job_id)`.

`getBaseResume()`, `saveBaseResume(data)`, `getTailoredResume(jobId)`, and
`bootstrapFromOnboarding()` round out `app/actions/resume.ts`.
`bootstrapFromOnboarding()` is opt-in and conditional: if
`profile.answers.resume` (the raw pasted résumé text captured at
résumé-mode onboarding, `lib/profile.ts`) is non-empty, one Claude
extraction call turns it into a `BaseResume` draft the user reviews and
edits before saving — never written automatically. Question-mode onboarders
have no such text and start from a blank form; this is convenience, not a
dependency, and the rest of the feature works identically either way.

## Rendering and export

The existing (currently empty) "Resume design system" Claude Design
project gets one resume template designed visually. Per the
`claude-design-handoff` skill, what comes out of that project is a spec
plus a prototype, not production code: the `.dc.html` markup is mined for
structure and values and hand-reimplemented into this repo's own styling
conventions as a React component in `components/resume/`, taking
`BaseResume | TailoredResume` as props — it is not a literal import of the
exported file.

Export is `window.print()` behind a `@media print` stylesheet on that
component — no PDF library, no server-side rendering. Because nothing
in the design/handoff process validates print pagination, the template
needs an explicit validation pass after handoff: page breaks landing
mid-entry, margins, and multi-page overflow have to be checked by actually
printing (or print-previewing) a resume with enough content to span more
than one page, not assumed to fall out of how the template looks on
screen.

## Testing

- `resolveBaseResume` — pure repair function, unit tested the way
  `resolveProfile` is: malformed/missing fields fall back field-by-field,
  never object-wide; returned values are always fresh, never a shared
  reference.
- A dedicated test pinning that a non-admin actor is refused by `/resume`
  and by every `resume.ts` export — mirroring how `lib/auth-policy.test.ts`
  guards this app's other auth invariants. This is the one genuinely new
  invariant the feature adds; `auth-required.test.ts`'s existing blanket
  session-less-call check passes regardless of whether the `isAdmin` gate
  is even present, so it cannot be relied on to catch a missing or broken
  admin check on its own.
- A fixture test for the tailoring prompt builder in `lib/resume-prompt.ts`,
  same pattern as `lib/__fixtures__/fit-prompt.*.txt`.
- Migration correctness isn't unit-testable, but the RLS extension should
  be checked manually against a live database the same way `012_watchlist_signal.sql`
  was verified in production before being treated as done.

## Non-goals (restated)

Re-fetching full posting text; multiple base resumes or tailored-resume
history; a choice of templates; server-rendered PDF. See "Scope for v1"
above for why each is deferred rather than simply forgotten.
