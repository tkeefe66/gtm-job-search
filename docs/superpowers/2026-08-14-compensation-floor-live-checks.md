# Compensation floor — live checks and follow-ups

Merged to `main` at `2b06793` (13 commits from `65a4db0`). 531 tests / 26 files, build
green, `/roles` confirmed `ƒ (Dynamic)`. **Not yet deployed.**

Plan: `docs/superpowers/plans/2026-08-13-compensation-floor.md`
Spec: `docs/superpowers/specs/2026-08-13-search-settings-design.md`

Everything below needs a running app with `DATABASE_URL` and `ANTHROPIC_API_KEY`. None of
it was verifiable during implementation — no database, no API key, no browser existed in
that environment. Every one was reported SKIPPED rather than guessed.

## Deploy

No schema migration. `app_settings` is key/value jsonb, so the two new keys
(`comp_floor`, `comp_scoring_rescored_at`) need no DDL.

```bash
railway up --service web --detach
```

**One thing is NOT a no-op on an empty `app_settings`.** Search and crawl behave exactly
as before, but **fit scoring does not**: the prompt now carries a `Posted compensation:`
line whether or not a floor is set. That is deliberate — it is why the day-one rescore
offer exists — but it means scores shift on rescore even if you never open `/settings`.

## Live checks, highest value first

1. **The parser against real data.** The single biggest unknown. Nothing has ever run
   `lib/salary.ts` against the ~21 real `salary_range` values in `jobs`. Pull them and
   check each lands on the right kind:
   ```sql
   select distinct salary_range from jobs where salary_range is not null;
   ```
   Watch specifically for weekly/monthly figures — whether any real posting uses one is
   still unknown, and it decides whether the H1 fix and the L6 residual matter at all in
   practice.

2. **Does the model honor "cap at 3" over the AI-GTM floor-of-4?** The prompt's
   AI-DRIVEN GTM TRANSFORMATION RULE sets an unconditional floor score of 4 on three
   conditions, none about pay. A carve-out was added as the third arrow line *inside*
   that rule, with explicit precedence text, and the rendered prompt was read by two
   reviewers. But **prompt placement is not model behavior.** Set a floor above a known
   role's posted base at an established B2B SaaS company with an AI mandate, rescore it,
   and confirm it lands at 3 rather than 4.

3. **The day-one rescore offer, end to end.** On first load after deploy with scored rows
   present, the offer should appear. Run it. Confirm: it completes, the summary is
   accurate, and **it does not return on the next page load** (the
   `comp_scoring_rescored_at` stamp). Then confirm a later comp-floor edit *does* bring it
   back.

4. **The stamp's round trip.** Verify the row actually lands:
   ```sql
   select key, value, updated_at from app_settings where key = 'comp_scoring_rescored_at';
   ```

5. **Both toggles default OFF** and the table looks unchanged until you opt in.
   "Meets minimum" must not appear at all with no floor set.

6. **An OTE-only role is never hidden by the floor toggle.** This is the spec's hard
   line — comparing OTE against a base floor is forbidden.

7. **The duplicate-render fix (M2).** Derived from source, never rendered. Start a rescore
   from each card and confirm the spinner/error/summary appears exactly once, and that the
   finished summary survives a completed pass on both paths.

## Known residuals, none blocking

- **L6 residual:** `-ly` adverb forms still route to `unparseable` even when the adverb
  qualifies a following noun rather than the figure — `$180,000 - $220,000 monthly payroll
  cycle`, `$200,000 - $280,000 Hourly rate`. The bare unit *nouns* were fixed; separating
  the adverb cases needs a following-noun test the rule has no machinery for. Consequence
  is a role tagged "Range unreadable", visible by default.
- **L4:** period-qualified roles now share the "Range unreadable" tag with genuine parser
  failures, silting up the surface meant to expose real gaps. A distinct tag was out of
  scope; a dedicated `console.warn` covers the diagnostic need.
- **Component wiring is untested by dependency choice, not impossibility.** vitest runs
  `environment: "node"` with no jsdom/RTL. Three `Settings.tsx` wiring mutants survive
  (W3 narrowed, W5, W6). Every library-side twin is pinned. Adding jsdom + RTL would close
  them.
- **The compensation stamp is unversioned.** A future change to compensation's role in
  `scoreFit` needs a *new* key, not a reuse of this one.
- **`rescoreDismissed` is shared** — dismissing the fit-brain prompt also hides the
  compensation offer for that session. Pre-existing.
- **The fit-brain offer has no stamp of its own**, so with a custom brain stored it returns
  on every page load until dismissed. Pre-existing; `fit_brain_rescored_at` was
  deliberately not added.
- **A deliberate `as` cast defeats the `RescoreReason` brand.** Nothing in the codebase
  does this today.
- Three pre-existing bare-`tsc` `TS2802` errors in `lib/group-by-company.test.ts`. Invisible
  to `npm run build`, which does not typecheck that file.

## The fit prompt is now fixture-pinned — read this before editing the rubric

The 1–5 rubric moved from `app/actions/parse-role.ts` to **`lib/fit-prompt.ts`**
(`"use server"` forbids non-async exports, so nothing in `parse-role.ts` was testable).
It is pinned line-for-line by checked-in fixtures in `lib/__fixtures__/`.

**Regenerating a fixture blesses whatever the code currently emits.** This was demonstrated:
apply a mutant deleting the `1 = Poor fit` tier, regenerate, and the suite is green on a
rubric missing a scoring tier. So:

> **A fit-prompt fixture may only be regenerated in the same commit as the rubric change
> that motivated it, and the fixture diff must be read. A commit touching only fixtures is
> a red flag.**

## Carried debt: the swallowed-error class

`if (error)` where `error` is a **string** — an empty message is falsy, so the failure path
never fires. Clean build, wrong behavior, zero log output. Invisible by construction.

**Eight instances surfaced. Six fixed on this branch.** Seven sites remain, none of which
can reach the rescore stamp (verified — the stamp's only inputs are the batch query error,
the now-fixed `updateJob` check, and `countRemaining`):

- `app/actions/settings.ts:161`, `:176`, `:192`, `:251` (`writeSetting` / `deleteSetting` / `resetSetting`)
- `lib/ingest-roles.ts:142`
- `components/RolesTable.tsx:625`
- `components/RecruiterPanel.tsx:123`
- plus `getWatchedCompanyKeys`, which discards its query error entirely

**Decision: these get their own sweep branch after this merge**, rather than being folded
into a reviewed shipping branch. The cure already exists in-repo: `describeWriteFailure`
in `app/actions/settings.ts` — presence to detect (`error !== undefined`), substitution
only to describe.

## Two lessons worth keeping

**`"use server"` bars non-async *exports*, not test *imports*.** Server actions in this
repo ARE unit-testable — a guard that returns before any query was pinned in 4 tests, ~2 ms,
with no credentials. This excuse was accepted twice during implementation before being
disproven. What makes a path untestable is whether it reaches out, not which directive sits
at the top of the file. The corrected rule is now written into `vitest.config.ts`.

**Folding corrections into a plan produces contradictions that nothing checks.** This plan's
prose disagreed with its own code blocks and file lists **eight times**; the prose was right
every time. Every one was caught by an implementer running the code, never by re-reading the
plan. Two file lists would have committed a non-compiling tree. When correcting a plan,
the code block, the file list, and the cross-references beneath the correction all go stale
silently.
