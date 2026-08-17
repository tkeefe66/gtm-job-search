# Career-agnostic profiles and first-run onboarding — design

**Status:** revision 2, 2026-08-17. Not yet implemented. Approved in principle
(approach A, conversational + résumé entry, per-profile rubric generation,
onboarding required before the app is usable); this document is the detail behind
that.

**Revision 2 removes the grandfather branch.** Revision 1 kept the existing
account on its current criteria via a backfill migration. That migration was the
riskiest step in the document and rested on an unverified fact about the deployed
database. The existing account now runs the flow like anyone else, preserving its
tuned values by pasting them at the review step — see "The existing account goes
through the flow".

**Every `file:line` below was derived against `7af185e`.** They rot — re-derive
before implementing rather than trusting them.

## Problem

The app is built for one person. A second user can sign in today, be approved,
and land on `/discover` running searches against **Tom Keefe's résumé**, because
`DEFAULT_FIT_BRAIN` (`lib/search-criteria.ts:62`) is that résumé and
`DEFAULT_CRITERIA` (`:113`) is what `loadCriteria` falls back to when a tenant has
saved nothing. Nothing in the product asks who they are.

`/settings` already makes titles, locations, stack terms, the location rule, the
fit brain, a search ceiling and a comp floor editable per tenant — that work is
done. What is missing is (a) the parts still hardcoded to go-to-market, (b) any
moment where a new user is asked about themselves, and (c) a default that fails
loudly rather than substituting someone else's career.

### What is still hardcoded

| Site | Content | Generalises to |
|---|---|---|
| `lib/search-criteria.ts:62` `DEFAULT_FIT_BRAIN` | Tom's résumé | per-tenant, written at onboarding |
| `lib/search-criteria.ts:23` `DEFAULT_TARGET_TITLES` | GTM/RevOps titles | per-tenant (already editable, wrong default) |
| `lib/search-criteria.ts:41` `DEFAULT_GTM_STACK_TERMS` | Salesforce, HubSpot, Clay… | "tools of the trade" — SolidWorks, ANSYS, CATIA for a mechanical engineer |
| `lib/search-criteria.ts:103` `DEFAULT_LOCATION_TERMS` | Denver, Colorado, remote | per-tenant |
| `lib/search-criteria.ts:58` `ROLE_SEARCH_SYSTEM` | "specializing in go-to-market and revenue operations roles" | derived from the profile |
| `lib/fit-prompt.ts:178-183` TITLE SCOPE SIGNALS | RevOps/GTM title ladder | generated per profile |
| `lib/fit-prompt.ts:201-206` AI-DRIVEN GTM TRANSFORMATION RULE | GTM/AI mandate bonus | generated per profile, optional |
| `app/actions/discover.ts:14` | "find every significant AI and tech startup funding round… Series B and above" | the employer premise, per profile |

The rest of the fit rubric is already candidate-relative and needs no change —
"SENIORITY IS RELATIVE TO THE CANDIDATE, NEVER ABSOLUTE" (`lib/fit-prompt.ts:172`)
and "FINANCIAL SIGNALS — UPWARD ONLY, and only if the candidate cares" (`:185`)
were written to key off the candidate's own words. That prior work is why this
change is smaller than it looks.

## THE constraint: the fit golden set is a ship gate

`lib/__fixtures__/fit-golden-set.json` records expected scores for ten roles,
captured against Tom's fit brain **and the current rubric text**.
`lib/fit-agreement.ts` describes itself as "a SHIP GATE, not a metric": fit scores
were measured as effectively deterministic, so there is no noise for a difference
to hide in, and its two adversarial rows encode multi-hop precedence under
contradiction — the comp carve-out interplay specifically.

**Therefore the generalisation must be a behavioural NO-OP for Tom's profile.**
The technique is the one that worked for `DEFAULT_STATUSES`: make the shipped
values reproduce today's behaviour exactly, so the change is a shape change
rather than a behaviour change.

Concretely: fed `titleScopeSignals` and `domainBonusRule` carrying the **current
hardcoded text, verbatim**, `buildFitPrompt` must render byte-identical output to
today. The existing fixtures (`lib/__fixtures__/fit-prompt.no-floor.txt`,
`.with-floor.txt`) are the proof: if they need regenerating, the refactor changed
behaviour and is wrong.

That is a claim about the *builder*, and it is what the fixtures can prove. The
separate question of whether the existing user's *stored* values match what they
replaced is checked once, by hand, at the end — see Testing.

This also bounds the risk of the whole project. Nothing about Tom's scoring
changes; the code simply stops holding his answers.

## Design

### Storage — no new tables

Onboarding writes the criteria keys that already exist, plus five new
`app_settings` keys. `app_settings` is key/value jsonb precisely so a new setting
needs no migration (`lib/settings-store.ts:6`).

```
profileAnswers     jsonb   raw onboarding input, so generation can be re-run
employerPremise    text    what kind of employer Discover should hunt
titleScopeSignals  text    how seniority reads in this person's field
domainBonusRule    text    optional profile-specific scoring bonus ("" = omitted)
discoveryRecency   text    "matters" | "irrelevant" — see Discover's windows below
```

`employerPremise`, `titleScopeSignals`, `domainBonusRule` and `discoveryRecency`
join `TEXT_SETTING_KEYS`. `discoveryRecency` is a two-value enum stored as text
rather than a boolean because `mergeSettings`' shape guard compares `typeof`
against the default, and a future third mode ("only within N months") must not
require changing the stored type of every existing row.

`profileAnswers` is an object and therefore needs a fourth shape group —
`OBJECT_SETTING_KEYS` — because `SettingKeysAreFullyClassified`
(`lib/settings-store.ts:56`) makes an unclassified key a compile error. That
assertion is doing its job here; satisfy it, do not widen it.

`onboarded_at` is a **standalone key outside `SETTING_KEYS`**, following
`CRITERIA_CHANGED_AT_KEY` and `COMP_SCORING_RESCORED_AT_KEY`: it is a stamp the
app writes, not a setting anyone edits, and `mergeSettings` must never see it.

`stackTerms` keeps its key. Renaming it is a migration for no behavioural gain,
and `SETTING_KEYS` values must equal `Criteria` field names or every save becomes
a silent no-op (`lib/settings-store.ts:10`). Only its `/settings` label changes,
from "GTM stack terms" to something field-neutral.

### The flow

```
/welcome — reachable only when active && onboarded_at is unset

┌─ Step 1 ─ How would you like to start?
│    ( ) Answer a few questions        ( ) Paste a résumé
│
├─ Step 2 ─ QUESTIONS path            │  RÉSUMÉ path
│    · What do you do now?            │    · one textarea
│    · What job do you want next?     │    · plus "what do you want next?",
│    · Where? Remote?                 │      because a résumé says where you
│    · Anything that rules a job out? │      have BEEN, not where you are going
│
├─ Step 3 ─ one metered Claude call
│
├─ Step 4 ─ Review & edit  ← the load-bearing screen
│
└─ Finish ─ writes all keys in one transaction, stamps onboarded_at → /discover
```

Both doors converge on one generation call and write the same keys. The résumé
door is a different Step 2, not a second pipeline.

### Step 4, the screen that matters

The generated rubric fragments go into the prompt that scores every role, so a
bad generation is silently wrong scores — this codebase's signature failure
(`.claude/skills/swallowed-string-errors`, and the whole `describeWriteFailure`
apparatus, exist because of it). They are reviewed before first use, never
applied invisibly.

```
  Here's what we understood. Edit anything that's wrong.

  ┌────────────────────────────────────────────────────────┐
  │ Job titles to search for                               │
  │ ┌────────────────────────────────────────────────────┐ │
  │ │ Senior Mechanical Engineer                         │ │
  │ │ Staff Mechanical Engineer                          │ │  ← one per line,
  │ │ Principal Design Engineer                          │ │    same control as
  │ └────────────────────────────────────────────────────┘ │    /settings uses
  ├────────────────────────────────────────────────────────┤
  │ Where                          Tools of the trade      │
  │ ┌──────────────┐               ┌──────────────┐        │
  │ │ Denver       │               │ SolidWorks   │        │
  │ └──────────────┘               └──────────────┘        │
  ├────────────────────────────────────────────────────────┤
  │ ⓘ  THIS IS WHAT SCORES YOUR ROLES                      │
  │                                                        │
  │ About you                                              │
  │ ┌────────────────────────────────────────────────────┐ │
  │ │ [generated fit brain — long, editable]             │ │
  │ └────────────────────────────────────────────────────┘ │
  │                                                        │
  │ How seniority reads in your field                      │
  │ ┌────────────────────────────────────────────────────┐ │
  │ │ [generated title-scope signals]                    │ │
  │ └────────────────────────────────────────────────────┘ │
  └────────────────────────────────────────────────────────┘

  [ Start over ]                    [ Looks right — finish ]
```

The three scoring fields sit under one visually distinct heading because they are
categorically different from the search terms above them: search terms decide
which roles are *found*, and a wrong one is visibly missing results; the scoring
fields decide what every role is *worth*, and a wrong one looks exactly like a
correct one.

### Generation

- `lib/onboarding-prompt.ts` — PURE prompt builder, pinned by rendered fixtures
  the way `lib/fit-prompt.ts` is. `"use server"` forbids non-async exports, so the
  builder cannot live in the action (`lib/fit-prompt.ts` exists for this reason).
- `app/actions/onboarding.ts` — `generateProfile(answers)`, using `callStructured`
  (`lib/model-call.ts:101`), the provider-neutral entry point. Do not construct an
  SDK client; `clientFor()` and the module-level `MODEL` constant are gone.
- **Metered.** It calls Claude, so it is wrapped in `withBudget`. An unwrapped
  call bills the platform key uncapped and unrecorded — the defect
  `app/actions/parse-role.ts:38` documents having already shipped once.
- The response is **validated and repaired, never trusted raw**, in the style of
  `resolveStatuses` (`lib/job-statuses.ts`): unknown shape falls back to a safe
  value rather than reaching the prompt. A model that returns prose where a list
  was asked for must not produce a fit brain that is the word "undefined".

### The gate

**Not middleware.** It runs on the Edge runtime and cannot reach Postgres, which
is why the password gate is a cookie comparison (`CLAUDE.md`, `middleware.ts:22`).

The insertion point is `lib/require-actor.ts`, which every tenant-scoped page and
action already calls:

- `requireActorPage()` (`:56`) gains one branch: active, but no `onboarded_at` →
  `redirect("/welcome")`. It already redirects to `/signin`, so this is a second
  case of an established pattern.
- `requireActor()` (`:73`) gains the same check as a **throw**, with an exemption
  list for the onboarding actions themselves — mirroring `CRON_CALLED` in
  `app/actions/auth-required.test.ts:37`, and pinned the same way.
- **`isPlatform()` must bypass the check** (`lib/require-actor.ts:78`). The cron
  crawler runs as `PLATFORM_ACTOR` with no session and no tenant of its own;
  gating it would stop every nightly crawl with no error anyone would see until
  the roles stopped arriving.
- **`/admin` is exempt.** Otherwise a bug anywhere in onboarding locks the only
  admin out of approving users — the flow would hold the door shut on the one
  person who could open it. This is a route exemption in the same shape as the
  `CRON_CALLED` one, and it stands on its own terms: admin is platform operation,
  reads no criteria, and scores nothing.

### The existing account goes through the flow

**There is no grandfather branch.** Revision 1 specified a backfill migration to
leave the existing tenant untouched; revision 2 does not, because the migration
was buying less than it cost. The existing account runs onboarding like anyone
else.

What that removes: a migration against live data, a branch in `require-actor`, an
ordering constraint on when `DEFAULT_FIT_BRAIN` may be neutralised, and — the
reason this is the better trade — a fact about the deployed database that this
document could not check and would have had to be right about. The flow also gets
exercised, once, by the only person able to judge whether its output is any good.

**The values are preserved by hand, not by machine.** At Step 4 the existing
user pastes today's fit brain and the two rubric blocks in verbatim
(`lib/search-criteria.ts:62`, `lib/fit-prompt.ts:178-206` — these should be
handed over as text, not retyped). Generated titles and locations can be accepted
if they are right; the three scoring fields are replaced with what is already
tuned.

This matters because of the golden set. Its expected scores are pinned to the
current rubric *text*, and ~70 already-scored roles were scored under it. A
generated draft would split the table across two prompt versions with no way to
tell which scores are correct.

**Verify mechanically; do not trust the paste.** After finishing, render the live
fit prompt for that tenant and diff it against the pre-change output. A dropped
bullet or a trailing newline is exactly the silent divergence this codebase is
built to catch, and the check is a one-off.

Because the backfill is gone, `DEFAULT_FIT_BRAIN` becomes `""` in the same change
rather than waiting on a migration, and a search with an empty fit brain
**refuses to run** rather than falling back. Today the fallback is sensible; with
real tenants it means any gap in the gate scores a stranger's roles against Tom's
background — silent wrongness, which this codebase consistently chooses to fail
loudly on instead. `emptySearchReason` (`lib/search-criteria.ts:279`) is the
existing precedent for refusing with a reason.

**One operational note:** while onboarding is incomplete the gate holds the
existing user at `/welcome`, so it wants doing in one sitting. `/admin` stays
reachable throughout, per the exemption above.

### Discover's premise, and its windows

`employerPremise` replaces the hardcoded funding-analyst system prompt
(`app/actions/discover.ts:14`). The funding-shaped result fields (`raised`,
`backer`, `arr`, `exit_signal`) become **optional** in the extraction schema
rather than removed: they are meaningful for a venture-backed premise and absent
for "contract manufacturers in the Mountain West", and the fit rubric already
states that absence of financial data must never lower a score
(`lib/fit-prompt.ts:194`).

**The window chips are decided, not left open.** `FETCHABLE_RANGES` and
`PINNED_CHIPS` (`lib/discovery-windows.ts`) exist because *funding news* has a
recency that matters — a company that raised last week is a different lead from
one that raised a year ago. For a premise like "regional contract manufacturers",
a 7-day window is meaningless; those firms did not come into existence last
Tuesday.

Generation therefore emits `discoveryRecency: "matters" | "irrelevant"` as part
of the profile. When `irrelevant`, the window buttons and chips are hidden and
Discover offers a single un-windowed fetch. The invariants pinned by
`lib/discovery-windows.test.ts` (every fetchable range is charted; nothing sits in
two lists; the fetchable set is exactly `7d`+`30d`) continue to hold for the
`matters` case and are simply not exercised in the other — widening what one
click can bill still takes a failing test, as designed.

### Error handling

Per `.claude/skills/swallowed-string-errors`: every action returns
`{ error?: string }`, the string **can be empty**, and detection is by presence
(`!== undefined`), never truthiness.

The finish step writes many keys at once. It uses `tenantTransaction`
(`lib/supabase.ts:167`) so a partial profile cannot exist — a tenant with titles
but no fit brain would pass the `onboarded_at` gate and then score against
nothing. That block stays short and contains no Claude call, per that function's
own documented rule.

## Components

| File | Change |
|---|---|
| `lib/onboarding-prompt.ts` | NEW, pure. Prompt builder + response shape |
| `lib/onboarding-prompt.test.ts` | NEW, with rendered fixtures |
| `lib/profile.ts` | NEW, pure. Validate/repair the generated profile; project it onto setting keys |
| `lib/profile.test.ts` | NEW |
| `app/actions/onboarding.ts` | NEW. `generateProfile`, `saveProfile` (metered, transactional) |
| `app/welcome/page.tsx` | NEW |
| `components/Onboarding.tsx` | NEW. Four steps, two entry doors |
| `lib/settings-store.ts` | Four new keys; `OBJECT_SETTING_KEYS`; standalone `ONBOARDED_AT_KEY` + reader/writer |
| `lib/settings-effects.ts` | Entries for all five new `SettingKey`s — `Record<SettingKey, …>` makes omission a compile error |
| `lib/search-criteria.ts` | `DEFAULT_FIT_BRAIN` → `""`; `ROLE_SEARCH_SYSTEM` derived; new fields on `Criteria` |
| `lib/fit-prompt.ts` | Interpolate `titleScopeSignals` / `domainBonusRule`; omit the block entirely when empty |
| `lib/require-actor.ts` | Onboarding gate in both guards; `isPlatform()` bypass preserved |
| `app/actions/discover.ts` | System prompt from `employerPremise`; funding fields optional |
| `components/Discover.tsx` | Hide windows when `discoveryRecency === "irrelevant"` |
| `components/Settings.tsx` | Edit the new fields; relabel "GTM stack terms" |
| `db/` | **No migration.** `app_settings` is key/value jsonb |

## Testing

`vitest` here is `environment: "node"`, including only `lib/**/*.test.ts` and
`app/**/*.test.ts` — no jsdom, so the onboarding component itself is not
unit-testable and its logic belongs in `lib/profile.ts` where it can be.

1. **The fit-prompt fixtures are byte-identical** when the interpolated fields
   carry today's hardcoded text. This is the no-op proof and the most important
   test in the change: it shows the refactor moved the rubric's GTM blocks out of
   the code without altering a character of what the model receives.
2. `resolveProfile` repairs a malformed generation rather than passing it
   through: missing fields, wrong types, prose where a list belongs.
3. An empty `fitBrain` refuses the search with a reason rather than falling back.
4. The onboarding gate: active + no stamp → redirect; active + stamp → through;
   `isPlatform()` → through regardless; `/admin` → through regardless.
5. The action exemption list is exhaustive, in the shape of
   `app/actions/auth-required.test.ts`.
6. `SettingKeysAreFullyClassified` still compiles with the fourth shape group.
7. `lib/settings-effects.test.ts` covers all five new keys.
8. Rendered onboarding-prompt fixtures, in the manner of the fit-prompt ones.

The golden-set gate (`lib/fit-agreement.ts`) is **not** re-run as part of this
work, because test 1 proves the prompt did not change. If test 1 fails, the
golden set must be re-captured and that is a different, larger decision.

**One check is manual and not automatable here**, because it is about stored data
rather than code: after the existing user completes onboarding, render their live
fit prompt and diff it against the pre-change output. Test 1 pins the *builder*
against fixed inputs; it cannot tell whether the values that user actually pasted
match what they replaced. Do this once, at the end.

## Consequences worth accepting

- `DEFAULT_FIT_BRAIN` stops being a working fallback. That is the point, but it
  means a tenant who somehow reaches a search un-onboarded gets an error instead
  of results.
- Re-running onboarding overwrites edits made since. Approach A accepts this and
  handles it with an explicit confirm naming the fields that will be replaced,
  rather than with a permanent override layer.
- CLAUDE.md's "Single-user, AI-powered GTM/RevOps job search tool tuned to Tom
  Keefe's profile" opening becomes wrong, as does its description of the fit brain
  and search criteria. It must be corrected in the same branch.
- **The existing user's tuned values survive only if they are pasted correctly.**
  Revision 2 trades a migration that could be got right mechanically for a manual
  step that could be got wrong. That is the deliberate trade: the migration's
  correctness depended on an unverified fact about production, while this step's
  correctness is checkable afterwards by diffing the rendered prompt. A mistake
  here is visible and repairable; a mistake in the migration would have been
  neither.

## Revision corrections (1 → 2)

1. **The grandfather branch is gone.** Revision 1 specified measuring the
   deployed `app_settings`, backfilling the existing tenant's effective values,
   and only then neutralising the shipped defaults. The existing account now runs
   the flow like everyone else. This removes a live-data migration, a branch in
   `require-actor`, an ordering constraint, and the document's only unverifiable
   claim.
2. **`/admin` is exempt from the onboarding gate**, which revision 1 did not
   consider. Without it a bug in onboarding locks the only admin out of the
   approval screen — the flow holding the door shut on the one person who could
   open it.
3. **A manual verification step was added**, because test 1 pins the prompt
   builder against fixed inputs and cannot see what the user actually stored.

## Out of scope

- Editing the profile answers after onboarding (`/settings` edits the *outputs*;
  re-running the flow regenerates them).
- Multiple profiles per user.
- Any change to the crawler, link health, or the status machinery.
- Re-capturing the fit golden set for a non-GTM profile. Worth doing eventually —
  the gate currently proves agreement for one career only — but it needs a second
  real profile to capture against, which does not exist yet.
