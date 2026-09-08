# Verifiable sourcing: the job description is the product

Date: 2026-09-07
Status: DRAFT, revision 2. Revision 1 was reviewed by two independent agents and
several of its central claims were WRONG; see "What review changed" at the end,
which is kept rather than deleted because each error's reasoning constrains the
next one. Numbers were measured against production on 2026-09-07 and are cited
inline; anything unmeasured is marked as an assumption.

## The requirement, stated first because it changes what "working" means

**A role we cannot read the job description for is not a role this app can act on.**
Résumé tailoring is supposed to select bullets against what a posting asks for; fit
scoring is supposed to weigh the same text. Without the JD both are guessing from a
title and a company name. The success criterion is not "we found a role" or "the
link resolves" — it is **"we hold this posting's own words, and we use them."**

Both halves matter, and revision 1 missed the second one entirely.

## Measured state (2026-09-07)

| | |
|---|---|
| Rows in `jobs` | 195 |
| Visible (not `never_live`) | 123 |
| Rows whose JD has ever been read | **18** |
| Rows scored | 161 — i.e. 143 scored with no JD |
| Rows whose JD reaches résumé tailoring | **0** |

That last line is the finding that reorders this whole document. `loadJobForTenant`
(`app/actions/resume.ts:43`) selects eight columns and `posting` is not among them,
and `buildThemePrompt` (`lib/resume-prompt.ts:47`) renders only those eight. The
`posting` jsonb added by migration 017 is invisible to the theme prompt. **Every JD
the app has ever read is unused by the feature that needs it most.**

The enrich pass over 51 eligible rows: 8 read, 1 empty, 16 unreadable, 26 blocked by
the link guardrail. Of 86 rows still unread, by host: `job-boards.greenhouse.io` 18
(postings since closed), `indeed.com` 13, `openai.com` 12, `builtin.com` 8,
`ziprecruiter.com` 7, `corningjobs.corning.com` 5, `linkedin.com` 3, long tail 20.

A 120-row fetch probe: 56 unfetchable (403/timeout), 53 no structured job data, 11
with a schema.org `JobPosting`. Blockers concentrate in openai.com 17, indeed.com
12, ziprecruiter.com 7, builtin.com 5.

## Why the pipeline produces unreadable rows

Roles are sourced from a model's web search, and a search result is not a record:
the model returns whatever ranked (29 of 61 rows were reseller copies), the employer
is a transcription ("basten" for Baseten ×3; one row attributed to Pricefx whose
posting is Vendavo's), and nothing carries a stable identifier, so liveness cannot be
re-checked — Greenhouse 302s a closed req to its board root and `checkJobUrl` follows
the redirect and calls it live.

That diagnosis stands. What review changed is what follows from it.

## The plan, in the order the evidence supports

### Step 0 — Use the JDs already held (no new sourcing, one file)

Add `posting` to `loadJobForTenant`'s select and render `requirements` /
`niceToHaves` in `buildThemePrompt`. This makes 18 rows tailor against real posting
text today and is a prerequisite for every later step being worth anything: without
it, a pipeline that read every JD in the world would tailor exactly as blindly as it
does now.

Note this partially reverses a v1 ruling in
`docs/superpowers/specs/2026-08-24-resume-builder-design.md`, which deliberately kept
theme derivation on the stored summary fields and named re-fetching the posting as
"where to look first if theme derivation quality disappoints". The posting no longer
needs re-fetching; it is a column. The ruling's own escape hatch is the authority for
this change.

### Step 1 — Let the user paste a JD

A textarea on a role that feeds the existing extraction path (`readPosting`'s model
call, minus the fetch). Coverage becomes 100% for any role the user can open in a
browser, including the three populations no automation reaches: aggregator-only rows
(~36), employer sites that 403 our fetch (openai.com, 17 of 120 sampled), and sites
with no honest API and no readable HTML (Workday tenants, Corning, TE).

This is deliberately placed above the sourcing rebuild. Review's strongest argument
against this whole document was that the app's job is to get one person into five
interviews, not to build a machine-verified market index — and for the five roles
that matter, a paste box is complete coverage for an hour's work.

### Step 2 — Measure the numbers that decide whether Step 3 happens at all

Revision 1 gated on board coverage. That is necessary and not sufficient. Four
numbers, none yet measured:

1. **JD coverage over rows that MATTER** — `fit_score >= 4`, or status moved off
   `New`, or carrying a `tailored_resumes` row. Coverage over all 195 rows is a
   number nobody experiences; most inventory exists because search is cheap.
2. **Unread rows by `jobs.source`** (`Crawl` / `Role Search` / `Discover`). Step 3
   changes ONLY the crawl. The unread hosts are dominated by aggregators, which
   points at role search, not careers-page crawling — if so, Step 3 does not address
   the population this document measured.
3. **Board resolution split: READ slug vs GUESSED slug**, per vendor. This decides
   the safety of Step 3, not just its reach (see below).
4. **Board size distribution** at resolved companies, against the 300s Railway edge
   timeout and a measured 91.2s worst-case crawl.

### Step 3 — Board ENUMERATION, only if the numbers support it

Note the narrowing: reading a JD off a board API already ships (`fetchPostingBody`,
used by `readPosting` at ingest and enrich). What this step adds is **enumeration** —
asking a board what roles exist instead of asking a search engine.

**Resolution safety is the design's core, not a detail.** A guessed slug today
produces a bad LINK on a row that already exists, and every consumer hedges
accordingly (`ResolvedLink.precision`, `unlisted` never hiding, `absent` inert). A
guessed slug under enumeration CREATES ROWS: a stranger's postings ingested under
your company's name, URL-checked (they are live, so they pass), scored, billed, and —
because `betterCompanyName` correctly refuses to rename on a wholly different name —
stored with the right company and the wrong JD. From there `shouldAutoFile` can file
real roles away on a stranger's text, and `saved_resumes` can snapshot it.

Therefore:

- Only a slug **read** out of a stored employer URL (`parseBoardLink`) may source
  roles.
- A **guessed** slug may source roles only where the vendor publishes an employer
  name to corroborate it — Greenhouse's per-posting `company_name`, checked against
  `companyIdentityKey`. Ashby, Lever and Workable publish none
  (`PostingBody.company` is `""` for all three), so a guessed slug there is
  uncorroborated and must not source roles.
- Every stored resolution carries `board_source: 'read' | 'guessed'`, because
  downstream consumers must be able to hedge differently.

**Closure semantics must be handled explicitly, not assumed inert.** `seenTitles`
flows into `crawl_runs.role_titles`, and `titlesToClose` closes any `Crawl`-sourced
`New` role absent from two consecutive trustworthy runs. Board enumeration therefore
routes a slug guess into the one path that issues `UPDATE jobs SET status='Posting
Closed'`. Worse, a vendor returning `{"jobs":[]}` parses as a real empty board, the
run scores `empty`, and `runProvidesClosureEvidence` counts `empty` as evidence — two
nights of that closes every crawl-sourced New role at a company. So: a board-sourced
run is marked in `crawl_runs`, is excluded from closure evidence unless the slug was
READ, and `seenTitles` is emitted from the UNFILTERED board listing whatever gets
ingested.

**Where board state lives is not `watchlist`.** Two of `ingestRoles`' three callers
never touch it — Find Roles (`app/actions/roles.ts`) and role search
(`app/actions/role-search.ts`) ingest for arbitrary companies, and those are the
paths that created the reseller problem. `watchlist` is also unique on
`(tenant_id, company)` by exact string, so "resolve once per company" is really once
per tenant per spelling — the problem `companyIdentityKey` exists to solve. Board
state belongs in its own table keyed `(tenant_id, companyIdentityKey(company))`.

**Bounding.** Today the search/extraction step naturally caps a crawl at ~10 roles.
Enumeration removes that cap, and `ingestRoles` fans out unbounded `Promise.all`s for
`checkJobUrl` and `scoreFit` — `MAX_INGEST_READS` bounds reads only. A 400-role board
would issue 400 concurrent liveness checks at one host and ~400 scoring calls inside
a 300s request. Enumeration needs its own per-company ingest ceiling, and title
filtering must happen BEFORE ingest.

**Title filtering has no adequate matcher today.** `titleQueries` returns search
query strings, not titles; `findPosting`'s containment matching was built for
verification, where a false negative is safe, and would silently drop exactly the
idiosyncratic titles ("Business Systems Manager") that `stackQueries` exists to
catch. So either ingest the whole board and let scoring filter (more rows, more
spend) or add a model call to classify the board's titles (which removes the
"no extraction call" saving). This must be decided, with a measured recall number,
before Step 3 is built.

## Cost: corrected

Revision 1 claimed "no `web_search` call, no extraction call. One HTTP fetch returns
every posting." All three clauses were wrong or incomplete:

- **Not one fetch.** Greenhouse's and Workable's list endpoints omit the body, so
  those are 1 + N fetches per company — and Greenhouse is the largest host in the
  backlog above. Only Ashby and Lever carry descriptions inline. (Whether
  Greenhouse's `?content=true` list parameter avoids the N+1 is unprobed and cheap to
  control-test; it decides this paragraph.)
- **The extraction call remains.** `readPosting` makes one non-search model call per
  posting to turn text into structured detail. Board text does not bypass it.
- **The per-company delta may be negative.** Enumeration removes one call per company
  and makes readable exactly the roles that were previously skipped — so it adds up
  to `MAX_INGEST_READS` reads that never happened before. Cheaper per JD; plausibly
  more expensive per company. The honest claim is per JD, and it needs a number from
  `usage_events` rather than an argument.

Also: `withBudget` refuses tier `"none"` before `fn` runs, so a zero-Claude board
crawl is still blocked for a keyless tenant; and the cron route conflates `capped`
with `crawled: false`, ending the loop for the whole platform. Both are prerequisites
to touch, not consequences.

## Non-goals

- Paid job-board APIs or a headless browser. Both would work; neither is justified
  before Step 2's numbers exist.
- Retiring the HTML/search path. It remains the fallback for every company that does
  not resolve, and that set is not empty.
- Changing the fit rubric or the résumé selection algorithm.
- Fixing Find Roles / role search sourcing. Step 3 changes the crawl only. If Step
  2's second number says those paths own the problem, this document needs a sequel,
  not an extension.

## Operational signal (revision 1 named the risk and proposed nothing)

- `crawl_method` learns `fetch` / `search` only; a board tier needs a third value and
  a rule for when it is UNLEARNED.
- A board that stops resolving falls through to the HTML path, which succeeds — so
  `failing_since` stays null and crawl health reports the tenant healthy. The only
  symptom is spend rising, noticed on a bill weeks later. One counter — "companies
  that resolved a board last run and did not this run" — is the whole signal.
- `fetchBoard` maps 429 and 5xx to the same `null` as 404, so one tenant's probe
  storm silently degrades every other tenant to the fallback path. Distinguish them,
  at minimum in logs, before board fetches become a per-crawl dependency.

## Testing

Per `mutation-first-tests`, each must be shown to fail against the unfixed code.

- The theme prompt renders `posting.requirements`; deleting the field changes the
  rendered prompt (fixture-pinned, as the fit prompt is).
- A guessed slug with no corroborating employer name sources NO roles.
- A board-sourced run does not provide closure evidence unless its slug was read.
- An empty board never closes anything.
- `seenTitles` carries the unfiltered board listing even when ingest is filtered.
- A company with more postings than the ingest ceiling ingests exactly the ceiling
  and reports the remainder.
- 429 from a board is distinguishable from 404 at the call site.

## Deploy order

Migration first, through `db/migrate.mjs` — never `db/apply-schema.mjs`, which
re-creates the `insights_cache` table that `006_drop_insights.sql` dropped. Then code.

## What review changed

Recorded rather than deleted, because each error's reasoning constrains the next
change.

- **The biggest finding was not in the spec's subject at all**: the résumé builder
  never reads the `posting` column, so every JD held is unused. Revision 1 proposed
  refusing to tailor JD-less roles — a gate on a path that ignores the JD when it IS
  present. Now Step 0, ahead of all sourcing work.
- **"One fetch per company", "no extraction call", and "cost per company falls" were
  all wrong**, contradicted by comments in the very file revision 1 cited as its
  asset.
- **A guessed slug creating rows is a new failure class**, not a widening of an
  existing one. Revision 1's acceptance test (a non-empty board) proves the vendor is
  honest, not that the board is the right company's.
- **Board enumeration feeds auto-closure** through `seenTitles`, which revision 1
  mentioned only as a vague risk about posting ids.
- **`watchlist` is the wrong home**, because two of three ingest callers never touch
  it and its key is a raw company string.
- **Title filtering has no adequate matcher**, so "filtering moves client-side" was
  not a free move.
- **The strongest argument against the whole document** — a paste-JD box gets 100%
  coverage on the roles that matter — is now Step 1 rather than a rejected
  alternative.
