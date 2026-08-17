# Career-agnostic profiles and first-run onboarding — design

**Status:** revision 3, 2026-08-17. Not yet implemented. Approach and capture
method approved; revision 3 is the first version that two independent reviews did
not find structurally broken.

**Revision 2 was not implementable.** Two adversarial reviews — one auditing the
document against the code, one walking a mechanical engineer through the product —
found five blocking problems. Revision 3 resolves them, and the resolutions
simplified the design rather than growing it. The full list is in "Review
corrections" at the end; the three that changed the shape of the work:

- **The gate as specified recursed.** `requireActor()` is reached through
  `resolveTenantId()` by every tenant-scoped query, so a branch inside it that
  reads `app_settings` calls itself. It is now a page-level redirect only, and the
  action side is protected by empty criteria refusing rather than by a guard.
- **Every new key moves outside `SETTING_KEYS`**, following the documented
  `JOB_STATUSES_KEY` rationale that revision 2 argued against without engaging.
  This alone resolved four separate findings.
- **New users could not complete onboarding at all.** The only billed step is
  refused for anyone without an API key, and the remedy page sat behind the new
  gate. The admin — the one account that would have dogfooded it — is exempt from
  that failure and could never have found it.

**Every `file:line` below was derived against `7af185e`** and audited by review;
two were off by one and are corrected here. They still rot — re-derive before
implementing rather than trusting them.

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
| `lib/fit-prompt.ts:166-170` the 1–5 scoring guide | 4 requires "hands-on systems + AI/agentic building" | clause tails generated per profile |
| `lib/search-criteria.ts:93-94` `roleExtractionSchema` | `fit_signal` / `ic_flag` defined in GTM terms | per profile — and this one feeds the SCORE |
| `lib/search-criteria.ts:139` `stackQueries` | `` `"${tool}" revenue operations hiring ${place}` `` | per profile, or the family is hidden |
| `app/actions/roles.ts:108` | "Search for open go-to-market and revenue operations roles at …" | generated `fieldNoun` |
| `app/actions/role-search.ts:39` | "go-to-market / revenue operations roles … not just the obvious RevOps titles" | generated `fieldNoun` |
| `lib/crawler.ts:346` | the same sentence, search-tier crawl | generated `fieldNoun` |
| `app/actions/discover.ts:14` and `:133` | funding-analyst system prompt AND the user prompt's Series B rule, source list and literal searches | the hiring signal, per profile |

Parts of the fit rubric **are** already candidate-relative and need no change:
"SENIORITY IS RELATIVE TO THE CANDIDATE, NEVER ABSOLUTE" (`lib/fit-prompt.ts:172`)
and "FINANCIAL SIGNALS — UPWARD ONLY, and only if the candidate cares" (`:185`)
key off the candidate's own words, and absence of financial data is explicitly not
a deduction (`:194`) — which is what lets the venture-shaped fields degrade
quietly for a profile that has none.

**But revision 2 claimed the whole remaining rubric was neutral, and that was
wrong at the block that actually sets the score.** The 1–5 guide's own clause
tails are GTM-shaped, so a Principal Design Engineer would have been graded
against a definition of "strong" requiring agentic AI. Review found it; the table
above now reflects it.

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

Concretely: fed `titleScope` and `domainBonus` carrying the **current
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

Onboarding writes the criteria keys that already exist, plus **one new standalone
key holding the whole profile**. `app_settings` is key/value jsonb precisely so a
new setting needs no migration (`lib/settings-store.ts:6`).

```
PROFILE_KEY = "profile"      one jsonb document:

  answers        the raw onboarding input, so generation can be re-run
  fieldNoun      "mechanical design and manufacturing engineering"
  titleScope     how seniority reads in this field
  domainBonus    optional profile-specific scoring bonus ("" = omitted)
  hiringSignal   { name, sources, qualifier, hasRecency, extraFields }
  toolsAreWeak   true when tool-based search is not worth running for this field
```

#### Why standalone, and not in `SETTING_KEYS`

Revision 2 put five keys into `SETTING_KEYS` and needed a fourth shape group for
the object-valued one. That was wrong, and the codebase already says so.
`lib/settings-store.ts:106-116` documents `JOB_STATUSES_KEY` as standalone for
exactly these reasons: "Its value is an array of objects, and mergeSettings is
shape-guarded for the list/text/number values that ARE criteria fields. Putting it
in SETTING_KEYS would force a fourth shape group and edits to two currently-green
tests, to buy a merge this value never uses."

Every word applies here. The profile is never merged field-by-field, is never a
`Criteria` field, and is not edited as free text. Following the precedent
resolves four review findings at once:

- No fourth shape group; `SettingKeysAreFullyClassified`
  (`lib/settings-store.ts:57`) is untouched.
- No edits to `lib/settings-store.test.ts:313`, which asserts the three groups
  partition `SETTING_KEYS` exactly, nor to `:317-330`.
- No `DEFAULT_CRITERIA` field, so raw onboarding answers do not ride into
  `loadCriteria()` on every crawl and into every pure prompt builder's parameter.
  Membership in `SETTING_KEYS` would have forced that (`lib/settings-store.ts:9-11`).
- **`domainBonus` can be empty.** `app/actions/settings.ts:224` rejects empty text
  for every `TEXT_SETTING_KEY`, so revision 2 specified `""` as the "omitted"
  value and an editor that could never produce one.

It also sidesteps an aliasing hazard: `mergeSettings` copies arrays but not
objects (`lib/settings-store.ts:145-148`), so an un-overridden object-valued
criteria field would alias the module-level default for the life of the process —
the exact bug that copy loop exists to prevent, reopened for the one shape it does
not handle.

Reading and repairing it is `resolveProfile` in `lib/profile.ts`, pure and in the
shape of `resolveStatuses`: an unknown shape repairs to a safe value rather than
reaching a prompt.
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

### The gate — two mechanisms, each doing what it is good at

**Not middleware.** It runs on the Edge runtime and cannot reach Postgres, which
is why the password gate is a cookie comparison (`CLAUDE.md`, `middleware.ts:22`).

**And not `requireActor()` either.** Revision 2 put the check there, claiming
every tenant-scoped page and action passes through it. The first half is true —
review enumerated `app/{admin,discover,roles,settings,watchlist}/page.tsx` and all
five call `requireActorPage()`. The second half does not work: `lib/tenant.ts:39`
is `return (await requireActor()).tenantId`, and every tenant-scoped query
resolves its tenant through it — `readAllSettingsResult` calls it twice
(`lib/settings-store.ts:265-266`), as do `upsertSetting` (`:354`) and `withBudget`
(`lib/metered.ts:102`). A branch inside `requireActor()` that reads `app_settings`
therefore calls `requireActor()` again, unbounded. Revision 2 also cited
`CRON_CALLED` (`app/actions/auth-required.test.ts:37`) as the precedent for an
exemption list; that is a set of names **a test skips**, not a runtime mechanism,
and `requireActor()` takes no arguments and has no caller identity to match
against one.

So the gate splits, and the split is better than the thing it replaces:

**Pages — a redirect, for the user experience.** `requireActorPage()` (`:56`)
gains one branch: active, but no `onboarded_at` → `redirect("/welcome")`. It reads
the stamp through a dedicated reader that takes `actor.tenantId` explicitly and
never calls `resolveTenantId`, so there is no recursion. Cost is one extra query
per page render, on five `force-dynamic` pages.

**Actions — nothing at all.** They need no guard, because an un-onboarded tenant
has no stored criteria and `DEFAULT_FIT_BRAIN` is now `""` — so a search called
directly refuses through `emptySearchReason` (`lib/search-criteria.ts:279`) rather
than running on someone else's career. **The empty defaults are the action-level
gate**, and they fail in the direction this codebase always chooses: loudly, with
a reason, rather than silently producing plausible wrong output.

That removes the `AsyncLocalStorage` scope, the exemption list, the recursion and
the per-action round trip that revision 2 required, and leaves the correctness
guarantee stronger — a guard can be forgotten on a new action, whereas empty
criteria protect every path that has not been written yet.

**`isPlatform()` still matters** (`lib/require-actor.ts:78`). The cron crawler
runs as `PLATFORM_ACTOR` with no session and no tenant of its own. It is unaffected
by the page gate, but the empty-criteria refusal must not fire for it either — the
crawler resolves each tenant explicitly and those tenants are onboarded, so this
is a note to verify rather than a change to make.

**`/admin` opts out explicitly.** Revision 2 called it "a route exemption in the
same shape as the `CRON_CALLED` one"; no such shape exists, because
`requireActorPage()` does not know which route called it. It becomes a parameter
or a distinct `requireAdminPage()` — a per-call-site opt-out at
`app/admin/page.tsx:8`. Admin *actions* need nothing: `app/actions/admin.ts` reads
no criteria and scores nothing, so the empty-criteria protection is irrelevant to
it and there is no second lockout behind the Approve button.

### The API key comes first, or nobody gets in

**Revision 2 shipped a closed loop.** `generateProfile` is metered, correctly. But
`withBudget` refuses before the function runs when a tenant has no key —
`lib/metered.ts:125` is `if (tier === "none") return { capped: needsKeyMessage() }`
— and a brand-new tenant has no `tenant_api_keys` row. The remedy the banner
offers is `/settings`, which revision 2's gate redirected back to `/welcome`.
Every real new user was locked out at the first billed action.

**And the plan to dogfood it could not have found this.** `app/layout.tsx:43` is
`if (tenantId && !isAdmin)`, and `resolveTier` gives an admin the platform key. The
existing account — the one running the flow to prove it works — is the single
account exempt from its only blocking failure.

So the key is **Step 0**, before any question is asked:

```
┌─ Step 0 ─ Your API key            (skipped when one is already stored)
│    the existing ApiKeyPanel, inline, with the same copy as /settings
```

The action that stores it needs no exemption, because actions are not gated
(above). `generateProfile` returning `capped` renders as **a requirement with the
key field attached**, never as "something went wrong" — `needsKeyMessage()` is
already written as a sentence for exactly this.

**This flow must be tested by a non-admin account.** That is a requirement on the
verification, not a note: the admin path cannot exercise the tier-`none` branch at
all, so a second approved test account is the only way to know Step 0 works.

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

### Discover: the hiring signal

Revision 2 replaced the funding-analyst SYSTEM constant and called Discover
generalised. It is coupled at five layers, and that changed only the first.

| Layer | What is hardcoded |
|---|---|
| System prompt (`app/actions/discover.ts:14`) | "startup funding analyst", Series B rule, source list |
| **User prompt** (`:133`) | repeats all of it, *and* prescribes the literal searches: `"Series B funding {period}"`, `"startup raises millions {period}"`, `"AI startup funding {period}"` |
| Result schema | ten fields, six venture-only: `raised`, `stage`, `lead_investor`, `founded`, `traction`, `category` ("AI Infra", "Voice AI") |
| Time windows | `DateRange` is part of the cache's unique key `(tenant_id, date_range, search_term)` |
| Cards | `components/Discover.tsx` renders raised / stage / backer directly |

A system prompt saying "regional contract manufacturers" over a user prompt saying
"Series C rounds on TechCrunch" produces venture-funded software companies with a
manufacturing tagline, or nothing.

**What the feature is actually for.** `app/actions/discover.ts:25` gives it away:
*a company that closed a round last week has no RevOps req yet, while a company
hiring GTM systems people today more plausibly raised 6-18 months ago.* The job is
to **find employers before the job is posted, using a public event that predicts
hiring in your field** — then watchlist them and let the crawler watch their
careers page.

That job generalises completely. Funding is one instance of the signal.

**So the profile carries a hiring signal, not an employer premise:**

```
hiringSignal {
  name        "funding rounds"        │ "defence contract awards"
  sources     TechCrunch, Crunchbase… │ Defense News, GovWin, trade press
  qualifier   "Series B and above"    │ "over $50M"
  hasRecency  true                    │ true
  extraFields raised, stage, investor │ contract value, agency, program
}
```

Both prompts interpolate all five. The result schema becomes **a fixed core plus
generated extras**: every row carries `company`, `tagline`, `careers_url`,
`headquarters`, and one human-readable `signal` string — *"Raised $400M Series D
led by a16z"*, *"Won $2.1B USAF sustainment contract"* — with the generated extras
in a jsonb map for anything worth filtering on. That single `signal` field is what
makes the feature legible across domains, and it reads better than six sparse
columns even for the venture case.

**`hasRecency` answers the window question** that revision 2 left with nowhere to
live. When the signal is an *event*, windows mean something and the existing
`7d`/`30d` machinery is untouched. When it is a standing property, `DateRange`
gains a `"current"` member — so the cache key keeps working and
`discovered_startups` needs no schema change beyond the extras column.

Revision 2 also mis-stated the invariant it claimed to preserve:
`lib/discovery-windows.test.ts` asserts no range is both *pinned and legacy*;
`7d` and `30d` are deliberately in **both** `FETCHABLE_RANGES` and `PINNED_CHIPS`.
The real invariants are unaffected by adding `"current"`, but the sentence was
wrong and is corrected here.

**One thing to probe before building this.** Funding news is unusually
well-indexed and well-structured; contract awards are decent; "plant expansion" is
patchier. Run two or three real searches for a non-tech signal and read what comes
back *before* committing to the schema. If the signal is not findable, the honest
answer is to hide Discover for that profile rather than ship a tab that returns
noise — and that is a cheaper thing to learn now than after the redesign.

### The GTM text the revision-2 inventory missed

Revision 2's hardcoding table stopped one layer above where the text actually
lives. Five more sites, all taking the same interpolation technique, all defaulting
to today's string so the no-op still holds:

| Site | What it says now |
|---|---|
| `lib/search-criteria.ts:139` `stackQueries` | `` `"${tool}" revenue operations hiring ${place}` `` — so "tools of the trade" yields `"SolidWorks" revenue operations hiring Denver` |
| `lib/search-criteria.ts:93-94` `roleExtractionSchema` | `fit_signal` = "why a **GTM Systems / RevOps / Marketing Ops leader and AI practitioner-builder** might fit"; `ic_flag` defined as "building GTM systems and agentic AI workflows" |
| `app/actions/roles.ts:108` | "Search for open **go-to-market and revenue operations** roles at …" |
| `app/actions/role-search.ts:39` | "currently-open **go-to-market / revenue operations** roles … not just the obvious **RevOps** titles" |
| `lib/crawler.ts:346` | the same sentence in the crawler's search-tier prompt |

`roleExtractionSchema` is the one that matters most and was the least visible:
`fit_signal` becomes `fit_summary`, which `buildFitPrompt` hands the scorer as
`Summary:` — so GTM framing is an **input to the score on every row**, from all
three ingest paths, not a cosmetic label.

One generated `fieldNoun` covers four of the five. `ic_flag` needs its own
decision: if generalised, the "Builder / IC — apply anyway?" badge copy must
follow, and for fields with no equivalent concept it should be dropped rather than
reworded.

**The crawler is therefore no longer out of scope.** Revision 2 listed "any change
to the crawler" as excluded while its search-tier prompt hunts RevOps roles —
which would have left a mechanical engineer's tracked companies crawled for the
wrong roles indefinitely.

**And the 1–5 scoring guide itself is GTM-shaped**, which revision 2 explicitly
denied. `lib/fit-prompt.ts:166-170`: 2 is "a narrow ops/IC role with no
systems-building or strategic scope", 3 is "without broad ownership, systems
architecture, or AI/building upside", 4 requires "hands-on systems + AI/agentic
building". A Principal Design Engineer is graded against a definition of "strong"
that requires agentic AI. The clause tails become part of the generated
`titleScope` fragment, defaulting to today's text.

### The comp carve-out seam

`lib/fit-prompt.ts:206` ends the AI-GTM rule with
`${aiGtmCompCarveOut(inputs.compFloor)}`, whose text says the compensation floor
"overrides **this one**". Revision 2 said to omit the domain block when empty and
stopped there. Three consequences it missed:

1. With `domainBonus === ""` and a comp floor set — **the default state of every
   non-GTM user with a salary minimum** — the carve-out renders with no rule to
   override: a dangling pronoun in the prompt that scores every role.
2. Omitting the block leaves the surrounding `\n\n`, producing a doubled blank
   line. `lib/fit-prompt.test.ts:426-436` exists to fail on exactly that — "the
   visible symptom of a seam that assumed its fragment was always non-empty".
3. `lib/fit-agreement.ts:60-63` (`ADVERSARIAL_CASES[0]`, "Bandtop AI") encodes this
   precedence specifically.

So the carve-out renders only when **both** a comp floor and a domain bonus exist,
and the empty-block case gets its own fixture — revision 2's test list had only
the byte-identity one, which renders the full text and cannot see this.

Related: the literal `"TITLE SCOPE SIGNALS"` is a positional anchor in two live
tests (`lib/fit-prompt.test.ts:301`, `:323`). **The heading stays in the template**
and only the bullets are interpolated.
### The states around a billed call

Revision 2 wrote everything at Finish in one transaction, so nothing survived a
refresh, a closed laptop or a generation timeout — including `answers`, whose
stated purpose is re-running generation.

- **`answers` persist before Step 3**, not at Finish. They cost nothing to store
  and are the whole input to a billed call.
- **"Start over" states whether it re-bills**, and a per-field "regenerate just
  this" is the cheaper path for the common case of one bad field.
- **The résumé has a length cap** with a stated behaviour when exceeded, and the
  generated fit brain has one too. `FIT_BRAIN_MAX_CHARS` is 4000 for a reason: the
  brain is paid on every `scoreFit` and again on every rescore, so a 15k-character
  brain generated from a five-page CV is a permanent tax. `resolveProfile`'s repair
  rules include truncation, not only type coercion.

**Re-running onboarding routes through the same effects a save triggers.**
Revision 2 wrote the keys with `tenantTransaction` directly, which bypasses
`cachesToClear` (leaving `role_searches` and `discovered_roles` full of the
previous career), the `criteria_changed_at` stamp (the crawler's stale-closure
debounce) and the rescore offer — even though the fit brain just changed
wholesale. The result would be a `jobs` table scored half against career A and
half against career B, with nothing on screen distinguishing them. That is the
same silent divergence Step 4 exists to prevent, arriving through the back door.
A *re*-run also offers `runRescorePass`.

### Step 4 needs a worked example, not just fields

"Here is what we understood, edit anything that is wrong" over a block of rubric
prose gives the user no way to judge it. They have never seen the scoring prompt,
the only feedback loop is fit scores hours later, and a wrong fragment looks
exactly like a correct one — which is the spec's own reason for the screen.

So Step 4 **scores one sample role** and shows the score and rationale beside the
fields. A wrong fit brain becomes visible as "it scored a shop-floor technician
job a 4" in a way the prose never will. The sample is either a real posting the
user pastes or a canned one generated for their titles.

Deleting a field at review: an empty `titleScope` omits the block, which is fine;
an **empty fit brain is blocked at the screen**, not discovered later by
`emptySearchReason`.

### The résumé is the most sensitive thing this app will hold

It is stored as plaintext `app_settings` jsonb, next to an API key that gets AEAD
sealing with per-row additional data. The spec owes three statements:

- **Where it goes:** to the tenant's own model provider, on the tenant's own key.
  That is a genuinely good story and belongs on the paste screen, not buried here.
- **How long it is kept:** indefinitely in `answers`, so generation can be re-run
  without re-pasting — and that trade should be the user's, with a way to clear it.
- **Whether it is logged.** This codebase logs prompts and query lists liberally.
  The onboarding prompt must not be one of them.

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
| `lib/settings-store.ts` | Standalone `PROFILE_KEY` and `ONBOARDED_AT_KEY` + readers/writers; both literals added to `upsertSetting`'s key union (`:342-347`) |
| `lib/settings-effects.ts` | **No change.** Neither key is a `SettingKey`, so neither record can hold it — the same conclusion the status work reached |
| `lib/search-criteria.ts` | `DEFAULT_FIT_BRAIN` → `""`; `ROLE_SEARCH_SYSTEM` derived; new fields on `Criteria` |
| `lib/fit-prompt.ts` | Interpolate `titleScope` / `domainBonus` and the 1–5 guide's clause tails; heading stays in the template; carve-out renders only when both a floor and a bonus exist |
| `lib/require-actor.ts` | Page-level redirect only, reading the stamp with an explicit tenantId so it cannot recurse; `requireAdminPage()` (or a parameter) for the `/admin` opt-out |
| `lib/__fixtures__/fit-prompt-inputs.ts` | New `FitInputs` fields. **The one file where a careless edit blesses whatever the code emits** — read the rendered diff |
| `app/actions/roles.ts`, `app/actions/role-search.ts`, `lib/crawler.ts` | `fieldNoun` interpolation in three prompts |
| `lib/types.ts` | `Startup` gains `signal` + extras; `DateRange` gains `"current"` |
| `components/Nav.tsx`, `app/layout.tsx`, `app/signin`, `app/gate` | The product still says "Tom's GTM Job Search" in five places |
| `app/actions/discover.ts` | BOTH prompts from `hiringSignal`; fixed core + generated extras schema |
| `components/Discover.tsx` | Windows shown only when `hiringSignal.hasRecency`; cards render the `signal` string plus generated extras |
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
   `/admin` → through regardless.
5. **The empty-block fixture.** `domainBonus === ""` with a comp floor set renders
   no dangling carve-out and no doubled blank line. Revision 2 had only the
   byte-identity fixture, which renders the full text and cannot see this;
   `lib/fit-prompt.test.ts:426` is the existing test of that failure class.
6. **`lib/settings-store.test.ts` passes UNEDITED.** It asserts the three shape
   groups partition `SETTING_KEYS` exactly (`:313`) — if it fails, a key went into
   `SETTING_KEYS` that the standalone decision says must not.
7. `lib/settings-effects.ts` is untouched, for the same reason.
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

## Revision corrections (2 → 3)

From two independent adversarial reviews — one auditing the document against the
code, one walking a mechanical engineer through the product. They overlapped
almost nowhere, which is the argument for having run them with different lenses.

**Blocking:**

1. **The gate recursed.** `requireActor()` is reached through `resolveTenantId()`
   by every tenant-scoped query, so reading `app_settings` inside it calls it
   again, unbounded. Now a page-level redirect with an explicit tenantId, plus
   empty criteria protecting the action side.
2. **The exemption list had no runtime mechanism.** `CRON_CALLED` is a set of names
   a *test* skips; the runtime cron exemption is `isPlatform()`, an
   `AsyncLocalStorage` scope. `requireActor()` has no caller identity to match a
   list against. Resolved by not needing exemptions at all.
3. **`/admin` could not be exempted where revision 2 put it**, and exempting the
   page would not have helped — the approval flow is server actions, so an
   un-onboarded admin would have hit the wall on clicking Approve.
4. **New users could not finish onboarding.** `lib/metered.ts:125` refuses before
   the function runs when `tier === "none"`, and the remedy page sat behind the new
   gate. The API key is now Step 0. Note the admin is exempt from this failure
   (`app/layout.tsx:43`), so it must be verified by a non-admin account.
5. **`domainBonusRule` was unwritable.** `app/actions/settings.ts:224` rejects
   empty text for every `TEXT_SETTING_KEY`; revision 2 made `""` its "omitted"
   value. Resolved by moving it out of `SETTING_KEYS`.

**Serious:**

6. **`aiGtmCompCarveOut` splices inside the block being extracted**, and says the
   comp floor "overrides this one". With no domain rule and a comp floor set — the
   default for every non-GTM user with a salary minimum — it renders a dangling
   pronoun. Plus a doubled blank line that `lib/fit-prompt.test.ts:426` exists to
   catch, and no fixture for the empty case.
7. **The GTM inventory missed five prompt sites**, including
   `roleExtractionSchema`, whose `fit_signal` becomes `fit_summary` and is an input
   to the score on every row from all three ingest paths.
8. **The 1–5 scoring guide is itself GTM-shaped**, which revision 2 explicitly
   denied.
9. **Discover is coupled at five layers, not one.** Revision 2 changed the system
   prompt; the user prompt carries the Series B rule, the source list and the
   literal searches. Replaced with the hiring-signal redesign.
10. **The storage decision was already made the other way, with a written
    rationale revision 2 did not engage** (`lib/settings-store.ts:106-116`).
11. **Byte-identity proves less than claimed.** The fixtures render from
    `FIXTURE_BRAIN`, not `DEFAULT_FIT_BRAIN` — good (emptying the default cannot
    move a fixture) but it means the fixtures bound the *builder*, not "the risk of
    the whole project". `fit-prompt-inputs.ts` was also missing from Components.
12. **Two citations were off by one** (`settings-store.ts:56`→`57`,
    `supabase.ts:167`→`165`) and one invariant was restated wrongly —
    `discovery-windows.test.ts` asserts no range is both *pinned and legacy*;
    `7d`/`30d` are deliberately in both lists.
13. **The crawler was excluded from scope** while its search-tier prompt hunts
    RevOps roles.
14. **Re-running onboarding bypassed the settings effects** — no cache clearing, no
    `criteria_changed_at` stamp, no rescore offer — leaving a `jobs` table scored
    half against one career and half against another.
15. **Nothing persisted before the billed call**, so a refresh or timeout lost the
    answers whose stated purpose is re-running generation. And no length bound on a
    generated fit brain, which is paid on every `scoreFit` (`FIT_BRAIN_MAX_CHARS`
    is 4000 for a reason).
16. **Step 4 asks something unrealistic.** Vetting generated rubric prose gives the
    user no way to judge it. Scoring one sample role and showing the result next to
    the fields makes a wrong brain visible.
17. **Privacy was unaddressed** — a résumé stored as plaintext jsonb beside an API
    key that gets AEAD sealing with per-row AAD.
18. **The product still carries the previous user's name** in five places.

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
- Link health and the status machinery. (**The crawler is no longer out of scope** —
  its search-tier prompt at `lib/crawler.ts:346` hunts RevOps roles, so excluding it
  would leave a mechanical engineer's tracked companies crawled for the wrong
  thing forever. Revision 2 excluded it without checking.)
- `BOARD_VENDORS` coverage. Link repair resolves Greenhouse/Lever/Ashby/Breezy/
  Workable; manufacturing runs on Workday and iCIMS, and Workday is excluded for a
  documented reason. "Check links" degrades to the 404 re-check, which is still
  useful — but say so rather than letting it read as broken.
- Search quality for generic titles. "Mechanical Engineer" matches an ocean where
  "Head of GTM Systems" matches a handful; there is no pagination or cross-run
  dedupe, so the same arbitrary 25 return each time. That needs a retrieval
  design, not an onboarding change.
- Re-capturing the fit golden set for a non-GTM profile. Worth doing eventually —
  the gate currently proves agreement for one career only — but it needs a second
  real profile to capture against, which does not exist yet.
