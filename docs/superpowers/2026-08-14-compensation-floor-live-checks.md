# Compensation floor — live checks and follow-ups

**DEPLOYED 2026-08-14.** `main` at `495a8b3`, 533 tests / 26 files, build green,
`/roles` confirmed `ƒ (Dynamic)`. Verified in the running container, not just on a green
deploy status.

Plan: `docs/superpowers/plans/2026-08-13-compensation-floor.md`
Spec: `docs/superpowers/specs/2026-08-13-search-settings-design.md`

None of this was verifiable during implementation — no database, no API key, no browser
existed in that environment, and every check was reported SKIPPED rather than guessed.
The section below records which have since been run against production and which have not.

## Deploy

No schema migration. `app_settings` is key/value jsonb, so the two new keys
(`comp_floor`, `comp_scoring_rescored_at`) need no DDL.

```bash
railway up --service web --detach
```

**Confirm the service.** The linked service is `crawler`, so a bare `railway up` deploys
the app over the cron service. `--service web` is not optional.

**One thing is NOT a no-op on an empty `app_settings`.** Search and crawl behave exactly
as before, but **fit scoring does not**: the prompt now carries a `Posted compensation:`
line whether or not a floor is set. That is deliberate — it is why the day-one rescore
offer exists — but it means scores shift on rescore even if you never open `/settings`.

## The boundary rule (changed 2026-08-14, after first use)

A band whose top only **reaches** the floor counts as **below** it — `>`, not `>=`.
`$150,000 - $200,000` is below a $200,000 floor; `$177,000 - $221,000` clears it. Hitting
the number would mean negotiating to the absolute ceiling of the band, which is the best
possible case of failing to meet a minimum rather than meeting one.

This lives in **two places that must not drift**: `lib/salary-filter.ts` (the display
bucket) and `compScoringClause` + `aiGtmCompCarveOut` in `lib/fit-prompt.ts` (the scoring
rule). Changing one without the other produces the table-vs-score split the whole-branch
review existed to catch — a role hidden by the filter while its fit score still reads 4.
The carve-out needs it too: it outranks the compensation clause, so a narrow reading of
"below the minimum" there re-opens the split through the one rule that beats it.

## Live checks

**Done, against production 2026-08-14:**

1. ~~**The parser against real data.**~~ **PASSED.** All 20 distinct `salary_range` values
   in `jobs` parse correctly: 19 `base`, 1 `ote`, **zero unparseable, zero absent**.
   `$280,000 - $325,000 (base); $305,000 - $365,000 OTE` → base max 325,000, not the OTE
   figure. `$165,000 - $175,000 base + annual bonus` → 175,000, not confused by the bonus.
   **No weekly or monthly figures exist in the data at all**, so the H1 fix and the L6
   residual do not fire in practice.
2. ~~**The day-one rescore offer.**~~ **PASSED.** 41 roles, two batches, `0 scoring
   failures, 0 write failures`, 41 Claude calls — no over-billing. The log showed
   `16 still to do` after batch 1 (cumulative, not per-batch) and `batch of 16 (limit 16)`
   on the tail, so both the over-billing and the never-terminating bugs stayed fixed.
3. ~~**The stamp round trip.**~~ **PASSED.** `comp_scoring_rescored_at` written at
   `2026-08-14T20:52:07.203Z`; the offer does not return.

**Still open — needs a browser or a billed call:**

1. **Does the model honor "cap at 3" over the AI-GTM floor-of-4?** *Still the one
   unverified claim in the feature.* The rule sets an unconditional floor score of 4 on
   three conditions, none about pay. The carve-out is verifiably the third arrow line
   *inside* that rule with explicit precedence text, read by two reviewers and pinned by
   fixtures — but **prompt placement is not model behavior.** With a floor set, a
   below-floor role at an established B2B SaaS company with an AI mandate must land on 3.
   The band-top case (`$150,000 - $200,000` at a $200,000 floor) is the same test for the
   newer rule.

2. **The rescore offer after a floor *edit*.** The day-one offer is stamped and gone.
   A later comp-floor edit should bring it back via the session flag. Confirm it does —
   and note a prompt-text change alone offers nothing, since it touches neither the stamp
   nor the session flag. Re-saving the floor is the way to force a pass.

3. **Both toggles default OFF** and the table looks unchanged until you opt in.
   "Meets minimum" must not appear at all with no floor set.

4. **An OTE-only role is never hidden by the floor toggle.** This is the spec's hard
   line — comparing OTE against a base floor is forbidden. `$300,000 - $340,000 OTE` is
   the live row that proves it.

5. **The duplicate-render fix (M2).** Derived from source, never rendered. Start a rescore
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

**Eight instances surfaced. Six fixed on this branch.** Seven sites remained, none of which
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

### What actually happened (2026-08-14, after this doc was written)

The sweep ran — `71aa3d7`…`440ff89`, deployed — and closed the four `settings.ts` writes,
`getWatchedCompanyKeys`, and `RolesTable`'s reload/optimistic-write path. **It missed four
sites**, found by re-reading the list above against the code rather than trusting this
section:

- `lib/ingest-roles.ts:142` — the worst of them. On an empty message the role was pushed
  to `added` and reported as stored, and the next crawl's dedupe would have skipped it as
  already seen. Now `describeWriteFailure`; pinned by `lib/ingest-roles.test.ts`.
- `components/RolesTable.tsx:720` and `components/RecruiterPanel.tsx:123` — both `addJob`
  writes. Now `describeWriteFailure`. Wiring untestable (no jsdom); the cure is
  library-pinned.
- `components/RolesTable.tsx:681` and `components/RecruiterPanel.tsx:59` — reads of
  `parseJobUrl` / `parseRecruiterText`, whose catch blocks returned `err.message`
  verbatim. Fixed at the source in `app/actions/parse-role.ts` rather than at the call
  site: `UNDESCRIBED_DB_ERROR` names the database and would have been the wrong sentence
  for a Claude failure. Pinned by `app/actions/parse-role.test.ts`.

`scoreFit`'s `error` field has the same shape but no truthiness reader — every caller
branches on `score > 0`. Left alone.

**Still unaudited:** the wider set of `if (res.error)` reads on `string`-typed errors in
`Discover.tsx`, `Settings.tsx`, `Watchlist.tsx`, `Insights.tsx`, and `RoleSearchPanel.tsx`.
Those were never on the list of eight; nobody has checked whether their sources can return
an empty message.

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
