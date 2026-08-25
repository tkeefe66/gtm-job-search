# Résumé content curation + voice input — design

Date: 2026-08-25
Status: approved for planning

Extends `docs/superpowers/specs/2026-08-24-resume-builder-design.md`
(revision 4) — read that first. This spec assumes its architecture as given:
`lib/resume-render/render.js` (the vendored, deterministic tailoring
engine — `selectBullets`/`renderBody`/`coverage`), `lib/resume-render/content/{resume,themes}.json`
(the checked-in career record and theme vocabulary), the `tailored_resumes`
table, and gating on `actor.isAdmin`.

Reviewed by two independent subagents before this version — a correctness
pass (verified the merge logic's types, the SQL/RLS/grant pattern, the
Next.js body-size default, Railway's private-networking behavior, and the
priority-ordering direction against the real code) and an adversarial
security pass focused on what this spec adds beyond the already-reviewed
base spec (the audio-upload path, the Whisper service's exposure, and
whether the approval gate is actually enforced or only asserted in prose).
Both passes' findings are folded in below rather than tracked as a
separate revision history, since this is the document's first version.

## The problem

Revision 4's tailoring pipeline is deliberately, structurally incapable of
fabrication: Claude only ever picks *themes*, and a pure function selects
*existing, pre-approved* bullets to match them. That safety came at a real
cost the base spec didn't name: with no way to add or improve content, the
whole feature is "smart filtering" over a fixed pool — something a person
could do by hand with the same JSON file. The AI-generation piece of the
original resume-builder concept went missing entirely.

This spec adds it back, in a shape that keeps revision 4's safety property
intact: **the AI is never the last step before something can appear on a
résumé.** It drafts candidate content or asks a clarifying question; a human
(the app owner, since this feature is single-owner) reviews and explicitly
approves before anything drafted becomes selectable. The trust boundary
moves from "validate what the model already produced" (revision 2/3's
rejected approach) to "the model can propose, only a human can admit" — a
stronger guarantee than post-hoc validation, not a weaker one.

## Scope for v1

**In scope**: detecting thin/absent theme coverage for a tailored job (via
`coverage()`, already built and unused); an AI-drafting step that proposes a
candidate bullet for an *existing* role or asks a targeted question when it
doesn't know enough to draft one; a typed or voice answer becoming raw
material for a draft; an approval gate (new DB table) between drafts and
the bullet pool `selectBullets` actually draws from; a self-hosted,
private-network-only Whisper service for voice transcription.

**Out of scope, named explicitly**:

- **Editing or removing bullets that already exist in `content/resume.json`.**
  Curation only *adds* new, approved bullets to roles that already exist.
  It never rewrites checked-in content and never modifies the file itself
  — approved bullets live in the database and are merged in at read time
  (see "Data model"). Changing an existing bullet's wording is still a
  by-hand edit to the file, same as revision 4 established.
- **Inventing a new role, employer, or position.** A curated bullet must
  attach to a `role.id` that already exists in the career record. This is
  the single biggest scope fence in this design — without it, "curation"
  slides into "build a résumé from scratch," which is a different, much
  bigger feature.
- **Automatic approval.** Nothing drafted — by the model or transcribed
  from a voice answer — is ever selectable without an explicit approve
  action from the app owner.
- **Speech output.** "Voice component" means voice *input* only — the app
  never reads its questions aloud. Named explicitly because the phrase is
  genuinely ambiguous.
- **Two-way conversation / multi-turn interviews.** One question, one
  answer, one resulting draft. No back-and-forth clarification loop in v1.

## Voice: a private, self-hosted Whisper service

A new Railway service (`whisper`) running `faster-whisper` behind a small
HTTP wrapper, reachable **only** over Railway's private network
(`*.railway.internal`) — no public domain, no direct browser access. This
is stricter than this app's existing second service: the `crawler` cron
service currently talks to `web` over a *public* `WEB_URL` plus a bearer
secret, not private networking (confirmed against how `use-railway`
describes this project's actual topology). The new service is deliberately
tighter, not just different — transcription audio has no public-facing
reason to exist, and this app already has the muscle memory for a
bearer-secret pattern to reuse.

**Binding gotcha, worth stating up front because it silently breaks
otherwise**: Railway's private network is IPv6-only **for environments
created before 2025-10-16** — Railway's own docs say newer environments
resolve both IPv4 and IPv6. This project's environment almost certainly
predates that cutoff (confirmed as a strong inference from deploy history,
not a fetched creation date), so treat it as IPv6-only in practice, but
verify against the actual `whisper` service rather than assuming the older
behavior forever. Either way the safe move is the same: the whisper
service must bind `::`, not `0.0.0.0` or `127.0.0.1` — binding to either of
the latter makes every private-network call fail with `ECONNREFUSED` in a
way that's easy to misdiagnose as an auth or routing problem, and `::`
works under both networking modes.

**Auth**: the shape of `lib/cron-auth.ts` — a shared secret, both sides
hash to a fixed-length digest, compared with a constant-time comparison,
fail closed if the secret is unset — is worth copying, but it is *not*
literally reusable: `cron-auth.ts` is TypeScript importing `process.env.CRON_SECRET`
directly, and `faster-whisper`'s ecosystem is Python-first. The whisper
service implements the equivalent independently in Python
(`hmac.compare_digest` over a sha256 digest of a `WHISPER_SECRET` env var,
set identically on both `web` and `whisper`), not by importing the TS file.

**Request path**: the browser records audio (`MediaRecorder`) and uploads
the blob to a new admin-gated server action in `web`
(`app/actions/resume-curation.ts`, gated the same way as the rest of the
résumé feature — see "Gating"), which validates it, forwards it to
`whisper` over the private network with the bearer secret, and returns the
transcript. **This is the one action in the whole résumé feature that
needs input validation the rest of it never did**, because every other
action takes structured JSON or a `jobId`, never a file upload:

- **Size ceiling, via a route handler, not a raised global limit.**
  Next.js Server Actions default to a 1MB request-body limit (confirmed
  against this repo's installed Next.js 14.2 — `experimental.serverActions.bodySizeLimit`);
  a real voice clip blows past that trivially. **Resolved in favor of a
  dedicated route handler** (`app/api/resume/transcribe/route.ts`) rather
  than raising `next.config.js`'s `bodySizeLimit` globally: a global raise
  widens the request-body ceiling for every Server Action in the app —
  including ones with no reason to accept more than a few KB, like a
  settings save — for the benefit of exactly one path. A route handler
  scopes the larger cap (a few MB, generous but bounded, enough for a
  short spoken answer) to just this one endpoint.
- **Content-type check**, before forwarding to `whisper`. This is a
  client-declared `Content-Type` check, not magic-byte sniffing — trivially
  spoofable in principle, but the caller is admin-gated (see "Gating"), so
  a spoofed type only risks a crafted file reaching Whisper's own decoder,
  not an attacker-reachable path.
- **Accepted, not fully closed: the body is received before the admin
  check runs.** Every Server Action and route handler in this app checks
  auth inside the handler body, not via middleware (middleware here can't
  reach Postgres — see CLAUDE.md's architecture notes) — so `web` buffers
  an uploaded body before `requireResumeAdmin()` gets a chance to reject a
  non-admin or unauthenticated caller who has the endpoint's shape from the
  client bundle. This is the same ordering every other action already has;
  what's new here is the payload can be MB-sized instead of KB-sized. The
  route-handler-scoped size cap above bounds how bad that gets — it doesn't
  eliminate the ordering, and no rate-limiting is in scope for v1.

The transcript **pre-fills** the answer text box; it is never submitted
automatically. Voice is a convenience for getting words into the box, not
a new trust boundary — the same human-approval gate downstream applies
identically to a typed answer and a transcribed one.

**Private networking is defense-in-depth, not the only control, and
that's worth saying plainly rather than leaving implicit.** The
`WHISPER_SECRET` bearer check (below) is what actually protects the
service; private-network-only placement is what keeps it from needing to
face that check against the public internet at all. This app has
documented history of exactly the Railway-misconfiguration class that
would undo the second part (`ADMIN_EMAIL` repointing is CLAUDE.md's own
worked example of this trap) — see "Deploy and rollout" for the explicit
check this earns.

*(Considered and rejected: browser-native `SpeechRecognition` — zero new
infrastructure, but Chrome-only and sends audio to Google. Self-hosting was
the deliberate choice here specifically to keep audio off a third party,
confirmed with the user rather than assumed.)*

## Gap detection and drafting

After `tailorResumeForJob` completes (revision 4's existing flow,
unchanged), `coverage(career, themes, selection, vocabulary)` — already
built in `render.js`, unused until this spec — runs against the derived
themes and the *current* merged pool (static + approved drafts, see "Data
model"). A theme reported `"thin"` or `"absent"` becomes a candidate gap.

This is **non-blocking**, per the earlier decision: `tailorResumeForJob`
still returns a résumé immediately from whatever's already approved.
Detected gaps surface as a small persistent list — on `/resume`, not tied
to any single job's page — so a gap noticed today can be answered next
week without re-deriving it. A gap is not re-shown once *any* draft
(`draft`, `approved`, or `rejected`) already exists for that exact
`(role_id, theme)` pair — answering it once, in either direction, retires
the prompt.

For a shown gap, one Claude call (`draftCurationBullet`, wrapped in
`withBudget()` — a new call site, stated explicitly rather than assumed
covered by the base spec's `tailorResumeForJob` wiring) does one of two
things:

- **Drafts a candidate bullet** for the thin role, if the career record
  already contains enough evidence elsewhere (other bullets, the role's
  `scope`/`accounts` fields) to support one without inventing anything.
- **Asks one targeted question**, if it doesn't. The question is specific
  enough to answer in a sentence or two ("did you personally own that
  migration, or support it?"), not open-ended.

A question's answer (typed or voice-transcribed) is sent back through the
same drafting call to produce a candidate bullet from it. Either path ends
at the same place: one candidate bullet, shown to the app owner for
edit-then-approve — never saved as `approved` in the same step it was
drafted.

## Data model

### `resume_bullet_drafts` — a new table

```sql
create table if not exists resume_bullet_drafts (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references users(id) on delete cascade,
  role_id      text not null, -- matches a ResumeRole.id in content/resume.json;
                               -- validated against the career record at write
                               -- time, not FK-enforced (roles live in a
                               -- checked-in file, not a table)
  bullet_id    text not null, -- stable id for the eventual ResumeBullet, e.g.
                               -- "draft-<uuid>" — namespaced so it can never
                               -- collide with a bullet id from content/resume.json
  themes       text[] not null default '{}',
  text         text not null,
  priority     integer, -- null until approval; see "Priority" below
  status       text not null default 'draft'
               check (status in ('draft','approved','rejected')),
  source       text not null
               check (source in ('ai_drafted','user_answer')),
  job_id       uuid references jobs(id) on delete set null, -- ADVISORY ONLY:
               -- which job's tailoring pass surfaced this gap. Nullable and
               -- not part of this row's identity — once approved, a bullet
               -- is pool-wide (any future job can select it), not scoped to
               -- the job that prompted drafting it. See "Scope: pool-wide,
               -- not job-scoped" below.
  created_at   timestamptz not null default now(),
  reviewed_at  timestamptz
);

create index if not exists resume_bullet_drafts_tenant_idx
  on resume_bullet_drafts (tenant_id);

alter table resume_bullet_drafts enable row level security;
alter table resume_bullet_drafts force row level security;

create policy tenant_isolation on resume_bullet_drafts
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

grant select, insert, update, delete on resume_bullet_drafts to app_rw;
```

This is a **second** table built the same way `tailored_resumes` was in
the base spec — `tenant_id` declared inline in `create table`, not added
via `alter table ... add column`. That means it hits the exact same
`TENANT_TABLES` regex gap the base spec documents (`lib/supabase.test.ts`'s
guard only matches the retrofit pattern): `resume_bullet_drafts` must be
added to `TENANT_TABLES` in `lib/supabase.ts` as its own explicit step,
not assumed covered by having fixed this once already for a different
table.

**Priority.** `selectBullets` orders bullets within a role by `priority`
(`CareerRules.taper` caps how many survive per role) — an approved draft
with no priority is invisible to that logic, not neutral. Default: an
approved bullet gets `priority = (max priority among that role's existing
bullets) + 1` at approval time, so it never crowds out real, established
history unless the app owner deliberately raises it. `priority` stays
`null` while `status = 'draft'` — nothing without a priority is ever
merged into a `CareerRecord` (see "Merging," next).

**Scope: pool-wide, not job-scoped.** Once approved, a bullet is available
to any future tailoring pass whose derived themes match it — not just the
job recorded in `job_id`. The whole point of curation is that the pool
gets stronger over time; scoping an approved bullet to the one job that
happened to expose the gap would mean re-answering the same question for
every future job in the same theme, which defeats it.

### Merging into `CareerRecord`

**The approval gate is enforced twice, independently, not asserted once in
prose.** The whole safety claim of this feature — "nothing drafted is
selectable without explicit approval" — rests on this merge step, so it is
specified as two separate, redundant checks rather than one function
trusted to get it right, the same doubled-check habit this codebase
already uses elsewhere for a similarly load-bearing absence check (the ATS
board-resolution pass verifies absence "by status and again by response
shape," CLAUDE.md):

1. **The loading query filters at the source.** Whatever loads rows for
   merging — call it `listApprovedDrafts(tenantId)` — queries
   `resume_bullet_drafts` `where status = 'approved'` explicitly (via the
   tenant-scoped `supabase.forTenant(tenantId)` builder, per "Gating"
   below — never a hand-written query missing the tenant filter). Its
   return type is `ApprovedDraftRow`, a narrower type than the raw table
   row: `priority: number` (never `null` — the column is nullable at the
   schema level only because a `draft` row hasn't been assigned one yet;
   an `ApprovedDraftRow` by construction always has one, since approval is
   exactly the step that assigns it). This also resolves a real type gap
   an earlier review caught: pushing a raw row's `priority: number | null`
   onto `ResumeBullet.priority: number` (`render.d.ts`) doesn't type-check
   without this narrowing.
2. **`mergeApprovedDrafts` re-filters internally rather than trusting its
   caller.** `mergeApprovedDrafts(career: CareerRecord, rows: ApprovedDraftRow[]): CareerRecord`,
   in `lib/resume-render/merge-drafts.ts` (this app's own code — not part
   of the vendored `render.js`, which owns rendering/selection, not this
   app's storage layer): deep-copies `career`, and for each row appends
   `{ id: bullet_id, priority, themes, text }` to the matching `role_id`'s
   `bullets` array. Even though `ApprovedDraftRow` can't represent an
   unapproved row by construction, the function still doesn't assume its
   caller is `listApprovedDrafts` specifically — a defensive check belongs
   here precisely because this function is the last line of defense if the
   loading side is ever refactored, copy-pasted, or gets a second caller
   that forgets the `where` clause. A row whose `role_id` no longer matches
   any role in the current `content/resume.json` (the file changed since
   the draft was approved) is skipped, not thrown — logged, not fatal,
   since the static file can be hand-edited independently of the database
   at any time.

`tailorResumeForJob` and the gap-detection `coverage()` call both run
against `mergeApprovedDrafts(career, await listApprovedDrafts(tenantId))`,
never the bare `content/resume.json` import directly, once this ships —
the static file is the *floor* of the pool, not the whole of it.

## Gating

Reuses `actor.isAdmin` throughout, per the base spec's established
reasoning (no new identity primitive). The new `app/actions/resume-curation.ts`
file's exports — `transcribeAudio`, `listGaps`, `draftCurationBullet`,
`saveDraftAnswer`, `approveDraft`, `rejectDraft` — all call
`requireResumeAdmin()` first, the same shared gate function
`app/actions/resume.ts` already defines (no second gate function invented
for this file).

**`approveDraft(id)`/`rejectDraft(id)` are admin-gated AND tenant-scoped —
being admin is not, on its own, license to mutate any row by id.** This
codebase has two real, established precedents for "mutate a row by id" and
they differ on purpose: `admin.ts`'s `setStatus(id, …)` writes to `users`
directly (a genuinely global table an admin operates across every tenant),
while every tenant-owned table is reached through
`supabase.forTenant(actor.tenantId).from(table).eq("id", id)…`, which
folds the tenant predicate into the query the same way RLS folds it into
the database. `resume_bullet_drafts` is the second kind — an
admin-gated action that mutated it by id alone, without going through
`forTenant`, would be pattern-matching the wrong precedent. Concretely:
`approveDraft`/`rejectDraft`/`saveDraftAnswer` all resolve their row via
`supabase.forTenant(actor.tenantId).from("resume_bullet_drafts").eq("id", id)`,
never a bare `.from("resume_bullet_drafts").eq("id", id)` and never
`rawQuery()`. (Being in `TENANT_TABLES` — see "Data model" — makes the
unscoped `supabase.from()` form throw at all, which is the mechanical
backstop for this; stating the scoped shape explicitly here is about not
reaching for `rawQuery()` to work around that throw.)

## Testing

- `mergeApprovedDrafts` — pure function, unit tested directly: an approved
  row lands in the right role at the right priority; a row whose `role_id`
  doesn't match any current role is skipped without throwing. Because the
  function's real parameter type is `ApprovedDraftRow[]` (see "Merging
  into `CareerRecord`"), the "a draft/rejected row is never merged" case
  can't be expressed by passing a same-typed-but-unapproved row — cover it
  instead as a `listApprovedDrafts` test (`where status = 'approved'`
  actually excludes `draft`/`rejected` rows), so both halves of the
  double-checked approval gate are independently tested, not just the one
  a same-shaped input could exercise.
- A fixture test for the drafting prompt builder (`lib/curation-prompt.ts`),
  same pattern as `lib/resume-prompt.ts`'s.
- The admin-gate refusal test extends to cover every export in
  `resume-curation.ts`, same as the base spec's for `resume.ts`.
- `transcribeAudio`'s validation: a unit test that a non-audio content
  type and an oversized payload are both rejected before any call to the
  `whisper` service is attempted.
- Migration correctness (RLS, grant, `TENANT_TABLES`) verified against the
  live database, same process as the base spec's "Deploy and rollout" —
  not unit-testable, per this codebase's own testing philosophy.

## Deploy and rollout

Adds to the base spec's migration/RLS steps:

1. Provision `WHISPER_SECRET` identically on both `web` and the new
   `whisper` service before either can reach the other; confirm the
   `whisper` service binds `::` (not `0.0.0.0`), or every private-network
   call fails closed with `ECONNREFUSED` and no clear signal why.
2. **Confirm `whisper` has no public domain provisioned** — private
   networking is defense-in-depth on top of the `WHISPER_SECRET` check
   (see "Voice"), not a substitute for it, and this app has documented
   history of exactly the class of Railway misconfiguration that would
   accidentally expose a service meant to stay internal.
3. Run the `resume_bullet_drafts` migration; confirm RLS, the grant, and
   its own `TENANT_TABLES` addition the same way "Deploy and rollout" in
   the base spec verifies `tailored_resumes`.
4. Confirm gating end-to-end as the app owner, restating the base spec's
   own check rather than assuming it still holds once curation adds new UI
   to `/resume`: the gap list, draft cards, and voice recorder all render
   for the admin account. If a second, non-admin test account is
   available, confirm none of that new UI appears and `approveDraft`/
   `rejectDraft`/`transcribeAudio` all refuse a non-admin caller directly.
5. End-to-end check as the app owner: record a short voice answer, confirm
   a transcript comes back; approve a drafted bullet; run
   `tailorResumeForJob` again for a job matching that bullet's theme and
   confirm it can actually be selected — proof the merge step is wired in,
   not just that approval writes a row.
