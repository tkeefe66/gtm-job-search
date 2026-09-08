# Posting detail: persist, extract, backfill

Date: 2026-09-07
Status: IMPLEMENTED 2026-09-07, all four parts (28a5610, e391364, eb96520, 6054b89).
Migration 017 is NOT yet applied to production and nothing is pushed — see "Deploy
order" below, which is now an open action rather than a plan.

Revised after review before implementation — see "Corrections" at the end for what
changed and why, since several of the first draft's claims were wrong. Two further
things this spec got wrong were only found by building it; see "Departures" at the end.

## Why

Three defects, one cause: `ingestRoles` produces posting detail, uses it once, and
throws it away.

**1. Two columns are never written.** `lib/ingest-roles.ts:150-174`'s `addJob` call
omits `key_skills` and `company_description`. Both columns already exist
(`db/schema.sql:19,24`). The model's `description_summary` is passed to `scoreFit`
as `key_skills` on the line after the insert, then discarded.

(`department` is a third such column, but it has no producer anywhere —
`lib/ingest-roles.ts:199` passes the literal `""` — so it belongs to part 2, not
part 1. See correction C2.)

**2. Résumé tailoring runs on nulls.** `loadJobForTenant` (`app/actions/resume.ts:45`)
selects eight columns, three of which are those above plus `department`. Worse than
inert: `lib/resume-prompt.ts:47` renders them through `optionalLine`, so they vanish
from the theme prompt silently rather than appearing as empty. Every tailored résumé
to date has been themed from `role_title`, `company`, `fit_summary`, `seniority` and
`salary_range` — the job title and the app's own opinion of it, never the posting.

**3. Scores drift between the initial score and a rescore.** `ingestRoles` scores
with `key_skills: role.description_summary` and a composed `company_description`;
`scoringArgsFor` (`lib/rescore-scope.ts:200,203`) reads those fields back off the row
and gets `""`. The rescore is strictly impoverished, and its score is the one that
persists. Nothing mitigates it, and a rescore is reachable from any `/settings` save
of a crawler-relevant key as well as from `compRescoreOffer`.

Severity varies by path, which the first draft did not distinguish: on role-search the
delta is small (a 1–2 sentence summary versus `""`), on Discover and Crawl it is real
(tagline + traction lost entirely).

A fourth, cosmetic but wider than first stated: `lib/ingest-roles.ts:133` composes
`` `${ctx.tagline ?? ""}. ${ctx.traction ?? ""}`.trim() ``, which yields the literal
string `"."` whenever both are absent. That is not only the role-search path — the
Discover (`app/actions/roles.ts:172-179`) and crawler (`lib/crawler.ts:766-773`) paths
pass `startup`/`tracked` fields that are frequently null, so any company with no
tagline and no traction sends `"."` to the model as its description.

## Goals

The expanded role row serves two jobs and only two: **decide** (apply or skip) and
**prep** (feed the application). Posting substance has to exist in the database for
either to work, and for the résumé builder downstream of both.

## Non-goals

- **The row's rendering.** Retiring Stage / Backer / ARR / Exit signal / Industry from
  the expanded row is a separate change. Those five populate only from the
  discovered-startup context and are inert in scoring by design
  (`lib/fit-agreement.ts:67`).
- **Conversational résumé refinement and the variant pool.** Depends on this.
- **Widening what closes a role.** `PostingVerification`'s `absent` member stays inert.
- **The `fit_summary` feedback loop.** Review surfaced a fourth drift this spec does
  NOT fix and should not: ingest scores with `fit_summary: role.fit_signal` (the
  extraction's one-liner) and then overwrites the column with the model's own rationale
  (`lib/ingest-roles.ts:209-210`). Every rescore therefore feeds the model its previous
  rationale where the first score saw the extraction's signal — a feedback loop, not
  merely a difference. Persisting more columns cannot fix it; it needs a decision about
  whether the rationale and the extraction signal should be separate columns. Recorded
  here so it is not rediscovered as a symptom of this work.

## Design

### Part 1 — Persist what ingest already has

Add `key_skills` (from `role.description_summary`) and `company_description` to the
`addJob` call in `ingestRoles`. No migration; both columns exist.

Fix the `"."` composition so an empty `ctx` yields `""`. Note what `""` actually does:
`lib/fit-prompt.ts:216,218,224` render `company_description`, `department` and
`key_skills` raw, with no `|| "unknown"` fallback (only `salary_range`, `arr`, `backer`
and `exit_signal` have defaults, lines 220-223). So `""` renders as a blank after the
label. That is correct and better than `"."`, but if a literal "unknown" is wanted, that
is a change to `buildFitPrompt`, which is pinned by all three fixtures in
`lib/__fixtures__/` and would require regenerating them — out of scope here.

**The structural guard, restated so it is satisfiable.** The first draft asserted a test
that would fail on day one. `SCORING_INPUT_COLUMNS` (`lib/rescore-scope.ts:36-48`) has
eleven entries; ingest writes five, part 1 adds two, part 2 adds `department` — leaving
`arr`, `exit_signal` and `backer`, which `scoringArgsFor` reads and `ingestRoles` has
never written and cannot: their only producer is the manual `InlineEdit` at
`components/RolesTable.tsx:1169-1175`.

So the guard needs both an exemption set and a mechanism:

```
EXEMPT = { arr, exit_signal, backer }
  // hand-entered from the discovered-startup context; inert in scoring by
  // design (lib/fit-agreement.ts:67). Ingest has no source for them.

test: stub addJob, run ingestRoles over a fixture role, then assert
      SCORING_INPUT_COLUMNS.filter(not in EXEMPT) ⊆ Object.keys(captured insert)
```

Capturing `addJob`'s argument is what makes this a real check rather than two
hand-maintained lists compared against each other — the "copies of themselves" failure
the existing comment at `lib/rescore-scope.ts:29-35` warns about.

### Part 2 — Extend extraction for decide + prep

`roleExtractionSchema` (`lib/search-criteria.ts:100-131`) asks for eight fields. Add:

- `requirements` — what the posting says it needs, in the posting's own words.
- `nice_to_haves` — stated preferences, separate because the decide question is "am I
  disqualified" and these do not disqualify.
- `department` — creating the producer that part 1's column lacks.

Stored in one new `posting jsonb` column via `db/migrations/017_posting_detail.sql`
(confirmed the correct next number; `db/migrations/` ends at `016_saved_resumes.sql`).
A migration file, not `db/apply-schema.mjs`, which would re-create the `insights_cache`
table that `006_drop_insights.sql` dropped.

**The column is nullable with NO default.** This is the same decision as part 3's "thin"
predicate, which is literally `posting is null`; a `default '{}'` would make every
pre-existing row look enriched and the backfill would skip the whole table.

**Grants need no action** — migration 009's column-list revoke is `users`-only, and
migration 003's table-level `grant … to app_rw` covers columns added later. Verified
previously for migration 012; recorded here so nobody re-derives it.

**Type it `posting: PostingDetail | null` and read it as `job.posting ?? null`
everywhere** — the same defensive contract `never_live` (`lib/types.ts:153-159`) and
`Startup.signal`/`extras` already carry for rows predating a column. `getJobs`
(`app/actions/jobs.ts:22`) and `repairJobLinks` both `select *` into `Job`, and the ES5
build will not catch a `job.posting.requirements` against a null.

**`ROLE_FIELDS` must be updated too** (`lib/types.ts:83-91`). It is the `itemFields`
list handed to `lib/prose-salvage.ts`, and its own comment says a missing name "just
quietly stops being asked for" — a live call on 2026-08-18 returned `{title,url,salary}`
for exactly this reason. `salvageSchemaFor` is open so nothing breaks loudly; the new
fields would simply vanish on every salvaged role.

**Two prompt tests will not bite.** `lib/company-role-prompt.test.ts:24` and
`lib/role-search-prompt.test.ts:43` rebuild their expected prompt by *calling*
`roleExtractionSchema`, so they go green on any schema change. The two `.toBe()`
assertions in `lib/search-criteria.test.ts:443-462` isolate one entry each and are
unaffected. Part 2 therefore needs its own assertion that the new fields are present.

The new fields must be tolerated as absent: a model that omits them yields an empty
list, never `undefined` reaching the row — the repair-don't-reject contract
`resolveProfile` and `resolveStatuses` already establish.

### Part 3 — Backfill: bounded bulk enrich

A new action `app/actions/enrich.ts`, surfaced as an **Enrich roles** button on
`/roles` (`components/RolesTable.tsx:564` is the precedent for wiring and the report
banner).

**Thin** means `posting is null` and status is non-terminal (`bucketFor`, the filter
`repairJobLinks` uses). Per thin row: verify the link (guardrail below) → plain HTTP
fetch → `classifyFetchOutcome` (`lib/crawler.ts:339`, already exported) → one non-search
Claude call over the stripped text → write `posting` plus part 1's columns.

**Bounded, batched and paged — not one pass over 60 rows.** The first draft's single
bulk pass was wrong twice over: `withBudget` (`lib/metered.ts:153-175`) reserves and
checks the ceiling exactly ONCE per call, so N model calls inside one scope pass a
single ceiling check at row 0 and then bill regardless; and 60 rows × (fetch + model
call) will not answer inside Railway's 300s no-data edge timeout, losing the return
value and with it any report of what was spent. `rescoreAll` is the template and it does
this correctly: `clampRescoreLimit` (`lib/rescore-scope.ts:166-171`, default 25 / max
100), one `withBudget` per batch, and the client pages on a returned `remaining` count.
Enrich follows that shape exactly — a `clampEnrichLimit` twin, per-batch reservation,
`remaining` returned, client-driven paging with progress.

**The link guardrail.** Enriching against a wrong URL writes fiction into the row, which
is worse than leaving it thin. The rule is *positive evidence of wrongness*:

| link / verification | enrich? |
|---|---|
| `classifyJobLink === "aggregator"` | resolve to the employer's posting first (`resolveEmployerLink`, the same treatment `upgradeLink` gives it); skip and report if that fails |
| `verifyPostingLink` → `listed`, `unreachable` | proceed |
| `verifyPostingLink` → `notApplicable` (own careers site) | proceed |
| `verifyPostingLink` → `relink` | repair the link first, then enrich against the corrected URL |
| `verifyPostingLink` → `absent`, `unclear` | blocked, reported with the reason |

The aggregator row is a correction: `verifyPostingLink` returns `notApplicable` for
*both* a company careers site and every aggregator link, and CLAUDE.md records that 29
of 61 rows were ZipRecruiter/Built In/Lensa. Enriching from a reseller's stale copy is
precisely the fiction this guardrail exists to prevent, and it is worse than a wrong ATS
link because the reseller answers 200 with plausible content long after the req closed.

**The `relink` repair must reuse `repairOne`'s path, not reimplement it.** Repairing
writes `{job_url, source_url: job.source_url ?? url}` — the first-relink-only rule at
`app/actions/link-health.ts:170`. A second copy of that rule is exactly the drift hazard
CLAUDE.md records for `compFloor`'s `>` vs `>=`. If the repair write fails, enrichment
must not proceed against a corrected URL that was never stored.

**Never escalate to search.** A JS shell yields no text; falling back to the `web_search`
tier would silently turn a free-tier backfill into a billed search across the table.
Skip, report, let the user decide.

**Robots.** The crawler gates on `fetchAllowed()` *before* `fetchPage`
(`lib/crawler.ts:365-371`), with an explicit "could not read the rules — don't guess"
rule. Extracting `fetchPage` into `lib/fetch-page.ts` must carry `fetchRobotsTxt` /
`fetchAllowed` with it and enrich must gate the same way. Silent divergence here is a
policy regression, not a bug.

**Gating.** `requireActor()` in the action, plus `readOnboardedAtFor(actor.tenantId)`
(`lib/settings-store.ts`). Citing `requireActorPage()` on `/roles` as coverage — as the
first draft did — is the mistake CLAUDE.md warns about explicitly: a Server Action is an
RPC endpoint addressed by an ID that ships in the client bundle, so a page guard does
nothing for it, and an un-onboarded tenant could call `enrichRoles()` directly and bill
against it.

`emptySearchReason` is still NOT the gate, but for a narrower reason than first stated:
it refuses on empty titles, stack terms, locations *and an empty fit brain*
(`lib/search-criteria.ts:335`). Enrichment reads none of those and is meaningful against
any profile, so it would refuse valid work. The onboarding check above is the gate that
actually applies.

**The enrichment prompt lives in `lib/` as a builder plus a test**, never inline in the
action — `"use server"` forbids non-async exports, which is why `buildFitPrompt` was
moved out of `parse-role.ts`. It is also a career-neutrality surface: any example text
in it ("e.g. Salesforce, Marketo") is the kind of thing
`lib/career-neutrality.test.ts` exists to catch, and the kind it would miss.

**Report shape.** Per-row outcomes with a presence-checked failure string, following
`LinkRepairReport`'s `UnclearReason` pattern, and distinguishing *blocked* (guardrail)
from *failed* (fetch died, model refused, write failed). Per the `{ error?: string }`
contract, branch on `describeWriteFailure(...) !== undefined`, never truthiness.

**Idempotence on an empty extraction.** If the model returns nothing usable, write
`posting` as a real value carrying an explicit empty marker rather than leaving it null
— otherwise that row is re-billed on every subsequent run. The report must count those
separately so a systematic extraction failure is visible rather than looking like spend.

## Deploy order

`db/migrate.mjs` is a hand-run, forward-only runner and the `web` service deploys
automatically on push to `main`. **Migrate first, then push.** Reversed, the running
code writes `posting` before the column exists and every enrich write fails with
`column "posting" does not exist`, surfaced through `describeWriteFailure` as a generic
sentence about storage with no hint of the cause.

## Testing

Per `mutation-first-tests`, each test must be shown to fail against the unfixed code.

- Ingest writes `key_skills` and `company_description` — delete each, the guard fails.
- The guard itself: add a fake column to `SCORING_INPUT_COLUMNS`, confirm it goes red;
  and confirm the exemption set is asserted, not merely subtracted, so removing
  `arr` from the exemption list also goes red.
- Empty `ctx` yields `""`, not `"."`, on all three ingest paths.
- Extraction schema: new fields present (the two self-referential prompt tests cannot
  provide this); a response omitting them yields empty lists, not `undefined`;
  `ROLE_FIELDS` contains them.
- Enrich: every row of the guardrail table, board and page fetches stubbed. An
  aggregator link resolves before enriching. A `relink` repairs before enriching, and
  enriches against the corrected URL. A failed repair write aborts that row.
- A `shell` page is skipped and never reaches a model call — remove the shell check and
  assert a call-count test fails.
- Batching: a pass over more rows than the limit returns a `remaining` count and
  reserves once per batch, not once per pass.
- The rescore offer: shows while any `posting.enrichedAt` is newer than
  `enrich_rescored_at`; disappears once the stamp advances past every enriched row;
  never shows when nothing is scored. Mutate the comparison to `>=` and confirm a test
  bites â the `compFloor` boundary hazard in the same shape.

`npm run build && npm test` is the gate; `npm run build` is what typechecks at ES5.

## Part 4 — The rescore offer

Decided: enrichment offers a rescore. A row that has just gained real `key_skills` and
`company_description` carries a `fit_score` computed from strictly less than a rescore
would now use, so leaving it is leaving a knowingly stale score on screen.

**The gate is server state, not a session flag** — the rule `compRescoreOffer`'s
comment (`lib/rescore-progress.ts:101-107`) establishes, for the reason given there: a
client component has no memory across page loads, and an offer that only exists in the
session is missing for the user who closes the tab mid-pass. Concretely:

- Enrich stamps `enrichedAt` inside the `posting` jsonb on every row it writes.
- A new `app_settings` key `enrich_rescored_at` records when a rescore last ran against
  enriched rows. Standalone, like `ONBOARDED_AT_KEY` — an app-written value nobody
  edits, so it must NOT join `SETTING_KEYS`, whose shape guard is for the list/text/
  number values that are `Criteria` fields.
- The offer shows while any row's `posting.enrichedAt` is newer than that stamp.

The decision is a pure function alongside the two that already exist, returning the
same branded `RescoreReason`, so the wording cannot be hardcoded at the call site — the
regression `fitBrainRescoreOffer`'s comment records (`lib/rescore-progress.ts:139-145`)
was exactly that. It renders on the enrich report and on `/settings` beside the others.

**The pass itself is `runRescorePass`, unscoped** (`lib/rescore-progress.ts:417`), never
a hand-rolled loop. Scoping it to just the enriched rows was considered and rejected as
premature: after a backfill, "enriched" is very nearly "every row", and scoping would
mean a second SQL path parallel to `SCORED_JOBS_SQL` whose batching and termination
rules would have to be re-derived — `passStartedAt` is what makes that loop terminate
rather than bill forever, and duplicating it is the drift hazard this codebase keeps
recording.

**One wrinkle to state rather than discover.** `SCORED_JOBS_SQL` orders
`updated_at asc`, and `updateJob` stamps `updated_at` unconditionally, so rows enriched
most recently sort to the **back** of the rescore queue — the rows that most need a new
score are reached last. Correct for a pass that runs to completion, mildly wrong for a
user who stops early. Acceptable at this size; if it ever matters the fix is an explicit
priority column, not a reordering hack.

## Risks

- **Prompt cost.** Two more fields on every extraction response, landing on all three
  search paths at once.
- **Enrich spend is real.** One non-search call per row. Bounded per batch now, but the
  user drives the paging, so the UI must show cumulative spend — `lib/cost-estimate.ts`
  has no vocabulary for per-row non-search calls today and needs one.
- **Extraction quality is unverified.** The crawler's fetch tier reads careers *listing*
  pages; this reads a single posting. If quality is poor the fallback is to narrow the
  ask, never to escalate to search.
- **`updateJob` stamps `updated_at` unconditionally** (`app/actions/jobs.ts:76`), so an
  enrich pass reshuffles the rescore queue's `order by updated_at asc`. Harmless, but
  surprising if an enrich and a rescore interleave.

## Corrections to the first draft

Recorded rather than deleted, because each one's reasoning constrains the next change.

- **`""` does not render as "unknown".** `buildFitPrompt` has no fallback for
  `company_description`, `department` or `key_skills`. The fix stands; the justification
  was wrong.
- **`department` had no producer**, so part 1 could not have written it. Moved to part 2.
- **The structural guard was unsatisfiable** against `arr` / `exit_signal` / `backer`,
  and had no stated mechanism. Now has both.
- **One `withBudget` over a 60-row pass is unbounded spend** — it reserves once — and
  would have exceeded Railway's 300s edge timeout. The first draft's remark about the
  nested-scope guard was reassuring about the wrong thing: the `relink` repair costs no
  model tokens, so there was never a second reservation to guard against.
- **`notApplicable` covers aggregator links too**, not just company careers sites, so
  "proceed" would have enriched from resellers' stale copies.
- **A page guard is not coverage for a Server Action.** The first draft cited
  `requireActorPage()`; the action needs its own onboarding check.
- **The `"."` bug and the drift both affect all three ingest paths**, not just
  role-search.

## Departures found during implementation

Two of this spec's instructions were wrong and were not followed. Recorded rather
than quietly fixed, because each one's reasoning constrains the next change.

- **`classifyFetchOutcome` cannot judge a POSTING page**, so part 3 does not use it.
  It delegates to `isJsShell`, whose second clause requires three job LINKS — the
  right question for a careers LISTING, and one a single posting has no reason to
  satisfy. Following the spec would have classified every real posting as a shell and
  skipped the entire table while reporting a clean pass. `readPostingPage`
  (`lib/page-extract.ts`) keeps only the length test, which is the half that actually
  detects an unrendered SPA, and a test pins that a posting with plenty of text and no
  job links is readable.

- **The report types live in `lib/enrich-scope.ts`, not in the action.** The spec put
  `EnrichReport` in `app/actions/enrich.ts`, but the banner that renders it is a client
  component and the pass driver imports the type — the reason `lib/link-report.ts`
  already gives for keeping `UnclearReason` out of the action: a type imported from a
  `"use server"` module drags that module into the client graph.

Two smaller decisions the spec left open, decided here:

- **Paging is by CURSOR, not by a `passStartedAt` twin.** The rescore's timestamp works
  because a re-scored row keeps matching the predicate; here an enriched row stops
  matching `posting is null` but a BLOCKED one never does, so re-reading the thin set
  would hand every later batch the same blocked rows — each costing another board
  lookup — and the pass would never drain. `enrichBatch` orders by id and resumes after
  the last row DECIDED, whatever its outcome.

- **Enrichment FILLS `department` and `key_skills`, never overwrites them.** A column a
  human edited, or an earlier ingest wrote, survives a backfill reading the page today.

## Still open after implementation

- **Migration 017 must be applied before the push.** See "Deploy order".
- **Per-row spend has no vocabulary in `lib/cost-estimate.ts`** (a Risk above, unchanged):
  the enrich banner reports counts, not dollars, so the user drives the paging without
  seeing cumulative spend.
- **The `fit_summary` feedback loop is untouched**, deliberately — see Non-goals.
- **Extraction quality is still unverified against a real posting.** The first live run
  is the test; if quality is poor the fallback is to narrow the ask, never to escalate
  to search.
