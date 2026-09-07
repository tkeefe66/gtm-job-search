# Posting detail: persist, extract, backfill

Date: 2026-09-07
Status: designed, not implemented

## Why

Three defects, one cause: `ingestRoles` produces posting detail, uses it once, and
throws it away.

**1. Three columns are never written.** `lib/ingest-roles.ts`'s `addJob` call omits
`key_skills`, `company_description` and `department`. All three columns already
exist in `db/schema.sql`. The model's `description_summary` is passed to `scoreFit`
as `key_skills` on the line after the insert, then discarded.

**2. Résumé tailoring runs on nulls.** `loadJobForTenant`
(`app/actions/resume.ts:45`) selects eight columns, three of which are the three
above. Every tailored résumé to date has been themed from `role_title`, `company`,
`fit_summary`, `seniority` and `salary_range` — the job title and the app's own
opinion of it, never the posting.

**3. Scores drift between the initial score and a rescore.** `ingestRoles` scores
with `key_skills: role.description_summary` and a composed `company_description`.
`scoringArgsFor` (`lib/rescore-scope.ts:196`) reads those same fields back off the
row and gets `""`. Same role, two different prompts, two different scores — and
the rescore's is the one that persists. This is a general defect in the shape of
the code, not a one-off: any scoring input that is computed at ingest rather than
stored will diverge on rescore.

A fourth, cosmetic: for role-first search `ctx` is `{}`, so
`` `${ctx.tagline ?? ""}. ${ctx.traction ?? ""}`.trim() `` composes the literal
string `"."`, which is then sent to the model as the company description.

## Goals

The expanded role row serves two jobs and only two: **decide** (apply or skip) and
**prep** (feed the application). Posting substance has to exist in the database for
either to work, and for the résumé builder downstream of both.

## Non-goals

- **The row's rendering.** Retiring Stage / Backer / ARR / Exit signal / Industry
  from the expanded row is a separate change. Those five are populated only from
  the discovered-startup context and are inert in scoring by design
  (`lib/fit-agreement.ts:67`); they are the wrong five fields to occupy the row,
  but that is a display decision. This spec only makes the right data exist.
- **Conversational résumé refinement and the variant pool.** Depends on this.
- **Widening what closes a role.** The `absent` member of `PostingVerification` is
  plumbed and inert; it stays that way here.

## Design

### 1. Persist what ingest already has

Add `key_skills` (from `role.description_summary`), `company_description` and
`department` to the `addJob` call in `ingestRoles`.

Fix the `"."` composition: an empty `ctx` must yield `""`, which is what the fit
prompt renders as "unknown", not a lone period the model reads as content.

**The structural guard.** A test asserting that every column `scoringArgsFor` reads
is a column ingest writes. `lib/rescore-scope.ts` already keeps
`SCORING_INPUT_COLUMNS` as an explicit list so that deleting a scoring input from
the rescore side fails a test; this closes the other end of the same loop. Without
it, defect 3 returns the next time a scoring input is computed inline.

### 2. Extend extraction for decide + prep

`roleExtractionSchema` (`lib/search-criteria.ts:100`) asks for eight fields. Add:

- `requirements` — what the posting says it needs, in the posting's own words.
- `nice_to_haves` — stated preferences, kept separate because the decide question
  is "am I disqualified" and these do not disqualify.
- `department` — an existing column with no producer.

Stored in ONE new `posting jsonb` column, via `db/migrations/017_posting_detail.sql`.

- **jsonb, not three text columns:** the conversational-refinement work will want
  more structure here, and one column means it does not cost a second migration.
  Same reasoning `app_settings` already uses for key/value jsonb.
- **A migration file, not `db/apply-schema.mjs`:** that script would re-create the
  `insights_cache` table which `006_drop_insights.sql` dropped.

`Role` (`lib/types.ts`) gains the two new fields. `roleExtractionSchema` is consumed
by `lib/company-role-prompt.ts`, `lib/role-search-prompt.ts` and `lib/crawler.ts`;
all three inherit the new fields with no call-site change. `lib/prose-salvage.ts`
maps a narrower shape and is unaffected.

The new fields must be tolerated as absent: a model that omits them yields an empty
list, never `undefined` reaching the row. Same repair-don't-reject contract as
`resolveProfile` and `resolveStatuses`.

### 3. Backfill: bulk enrich

A new action `app/actions/enrich.ts`, surfaced as an **Enrich roles** button on
`/roles` alongside Check links (`components/RolesTable.tsx:564` is the precedent
for the wiring and the report banner).

**Thin** means the row has a `job_url` and no `posting` value — it predates part 2,
or its extraction returned nothing. Status must be non-terminal (`bucketFor`, the
same filter `repairJobLinks` uses), so closed and rejected roles are never enriched.
Re-running the pass must skip rows already enriched rather than re-billing them.

Per thin row:

1. Verify the link. See the guardrail below.
2. Plain HTTP fetch of `job_url`.
3. `classifyFetchOutcome` (`lib/crawler.ts`, already exported): `shell` → skip.
4. One non-search Claude call over the stripped text → fill `posting` plus the
   three columns from part 1.

`fetchPage` is currently private to `lib/crawler.ts`. Extract it — with
`FETCH_TIMEOUT_MS` and `USER_AGENT` — into `lib/fetch-page.ts` and have both
callers use it, rather than duplicating a second fetcher with its own timeout.

**The link guardrail.** Enriching against a wrong URL writes fiction into the row,
which is worse than leaving it thin. But blocking every unverifiable link would gut
the backfill: most rows are company careers sites, where `verifyPostingLink`
correctly returns `notApplicable`. So the rule is *positive evidence of wrongness*:

| `verifyPostingLink` | Enrich? |
|---|---|
| `listed`, `notApplicable`, `unreachable` | proceed |
| `relink` | repair the link first, then enrich against the corrected URL |
| `absent`, `unclear` | blocked, reported with the reason |

**Never escalate to search.** A JS shell yields no text. Falling back to the
`web_search` tier would silently turn a free-tier backfill into a billed search
across every row in the table. Skip, report, and let the user decide.

**Metering.** Runs under `withBudget` (`lib/metered.ts`) like every other model
call. The nested-scope guard there means a single bulk pass reserves once.

**Correction to an earlier claim in this design's discussion:** enrich should NOT
call `emptySearchReason`. That guard is keyed to `RoleSearchFamily` and refuses on
empty titles, stack terms or location terms — none of which enrichment uses. It
would refuse a perfectly meaningful enrichment because the user has no location
terms set. Extracting a posting's stated requirements is career-neutral and useful
against any profile, so there is no profile state that makes this call meaningless.
The gates that do apply are the ordinary ones: `requireActor()` in the action, and
`requireActorPage()` on `/roles`, which already redirects an un-onboarded tenant.

## Testing

Per `mutation-first-tests`, each test must be shown to fail against the unfixed
code before it counts.

- Ingest writes all three columns — mutate by deleting each; the coverage test
  in part 1 must fail.
- The coverage test itself: add a fake column to `SCORING_INPUT_COLUMNS` and
  confirm it goes red.
- Empty `ctx` yields `""`, not `"."`.
- Extraction schema: new fields present; a response omitting them yields empty
  lists, not `undefined`.
- Enrich: each row of the guardrail table, with the board fetch and page fetch
  stubbed. `relink` must repair before enriching, and the enrichment must run
  against the corrected URL, not the stored one.
- A `shell` page is skipped and never reaches a model call — mutate by removing
  the shell check and assert the call count test fails.

`npm run build && npm test` is the gate. `npm run build` is what typechecks at
ES5; `npx tsc --noEmit` does not reproduce it.

## Risks

- **Prompt cost.** Two more fields on every extraction response. Small, but it
  lands on every search path at once.
- **Enrich spend is real.** One non-search call per row, ~60 rows on first run.
  The user chose a single bulk button over a dry-run gate; the report must state
  what was spent, and the button must not be adjacent to anything destructive.
- **Extraction quality on a fetched page is unverified.** The crawler's fetch tier
  reads careers *listing* pages; this reads a single posting. The prompt is new
  and its output is not pinned by a fixture in this design. If quality is poor the
  fallback is to narrow the ask, not to escalate to search.
