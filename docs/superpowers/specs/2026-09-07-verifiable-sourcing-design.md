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

### Step 1 — Add a role by URL, with paste as the fallback

Revision 2 proposed a paste box. A URL box is strictly better and the paste box
becomes its fallback, for a reason that is about identity rather than convenience:
**pasted text has no identity.** It carries no employer, no canonical link and no
posting id, so the user must supply the company and title by hand, liveness can never
be re-checked, and dedupe against existing rows has nothing to match on.

A URL, by contrast, feeds the path that already exists — `readPosting`: robots gate,
fetch, `readPostingPage`, and the board-API fallback for a client-rendered shell —
plus `hiringOrganizationFrom` for the employer's own name. So one pasted URL yields
the JD, the real employer, a canonical link and (on an ATS deep link) a posting id
that `verifyPostingLink` can re-check forever.

The flow:

1. User pastes a URL. The app reads it exactly as ingest and the backfill do.
2. **Read succeeded** — the role is created with its JD, employer name, department
   and a checkable link, and is scored against the real posting from the first
   moment.
3. **Read failed** — the URL is stored anyway, and a textarea appears *with the
   reason* ("this site blocks automated readers"). The pasted text goes through the
   same extraction call; the row keeps the URL, so liveness checking still works even
   though the JD came by hand.

That fallback is not a nicety: aggregator-only rows (~36), employer sites that 403
our fetch (openai.com, 17 of the 120 sampled) and sites with no honest API and no
readable HTML (Workday tenants, Corning, TE) are unreachable in principle, not merely
unimplemented. This is the only mechanism in the document that reaches them.

Placed above the sourcing rebuild deliberately. Review's strongest argument against
this whole document was that the app's job is to get one person into five interviews,
not to build a machine-verified market index — and for the five roles that matter,
manual intake is complete coverage for an hour's work.

**Open question:** whether a URL-added role should bypass `emptySearchReason` and the
crawl's dedupe. It ingests through `ingestRoles` like everything else, so the dedupe
is free; the gate needs a decision.

### Step 2 — MEASURED 2026-09-07, and it reorders the rest

| Question | Answer |
|---|---|
| JD coverage on rows scored 4 or 5 | **3 of 58** |
| JD coverage on rows moved off New | **9 of 41** |
| Rows by source | Role Search **133**, Crawl 32, Discover 30 |
| Unread AND open, by source | Role Search **46**, Crawl 12, Discover 1 |
| Links: employer ATS vs aggregator | 57 vs **76** |
| Watchlist companies with a READ slug already stored | 6 of 13 |

Two conclusions, both against revision 2's plan:

1. **The coverage problem is real where it counts.** Review's strongest objection was
   that coverage over all 195 rows is a number nobody experiences, and that the rate
   over rows the user actually engaged with might be fine. It is not: 5% of the rows
   scored 4-or-better carry a JD, and 22% of the rows the user has moved. The work is
   justified on the rows that matter, not just on inventory.

2. **Board enumeration in the CRAWL addresses the minority.** Role Search made 133 of
   195 rows and owns 46 of the 59 unread-open rows; the crawl owns 12. Revision 2 put
   crawl enumeration at the centre. Measured, it is the smallest of the three
   populations, and the reviewer who predicted exactly this was right.

The unread-open rows by host are `indeed.com` 13, `openai.com` 12, `ziprecruiter.com`
6, `corningjobs.corning.com` 5, `linkedin.com` 3, `builtin.com` 3 — i.e. almost
entirely the hosts that block automated readers. That is the population Step 1
reaches and no amount of sourcing cleverness does.

### Step 3 — Verify at ROLE SEARCH intake (the 133-row path)

The rebuild proper, and it belongs here rather than at the crawl because this is
where four fifths of the table comes from. Today a search hit is stored as whatever
link ranked. Instead, for each hit, before the row is written:

1. Resolve to the employer's own posting where possible — `classifyJobLink` plus
   `resolveEmployerLink` for an aggregator link, exactly as `upgradeLink` already
   does at ingest.
2. Read the JD through `readPosting` (page, then board API).
3. Take the employer's own name from the read (`hiringOrganizationFrom`, Greenhouse
   `company_name`) rather than the model's transcription.
4. Store the row with its JD, or store it marked unread with the reason — never
   silently as though it were verified.

`ingestRoles` already does steps 1-3 for up to `MAX_INGEST_READS` roles per run. What
this step changes is the BUDGET and the ORDERING for the search path: a role-search
run that finds 20 roles currently reads 6 of them. Raising that for a user-initiated
search (which has no cron timeout to respect, unlike the crawl) is most of the work.

### Step 4 — Board ENUMERATION for tracked companies (the 12-row path)

Kept, because a tracked company is exactly where a board pays off repeatedly, and
because 6 of 13 watchlist companies already have a READ slug stored — no guessing
needed for those. But it is last now, and its safety rules stand unchanged from
revision 2:

### What survives: the two discovery surfaces, with verification added

Revision 2 read as though boards would REPLACE search. They must not, and review
caught this as the split's biggest silent casualty. Both surfaces stay, and the
change to each is a verification step, not a replacement:

- **Discover (find companies)** is untouched. Searching a hiring signal for companies
  the user has never heard of is what a model is genuinely good at, and no board can
  do it — a board API answers "what is open at this company", never "which companies
  are hiring". What improves is downstream: once a found company's board resolves,
  its roles arrive complete and with descriptions, so "interesting company" becomes
  "here are their open roles" without a second billed search.

- **By Role (find roles like mine)** stays as the discovery mechanism, and this is
  the one revision 2 nearly broke. Role-first search exists precisely to catch roles
  at companies the user does NOT track, and titles a company-first crawl never
  surfaces — "Business Systems Manager", "Growth Systems Lead". A board-only pipeline
  cannot find those, because there is no board to ask until you already know the
  company. What changes: a search hit is resolved to the employer's own posting and
  READ before it is stored, instead of being stored as whatever link ranked. Same
  discovery, verified intake.

Stated as a rule: **search decides WHAT to look at; boards and the posting itself
decide WHAT IS TRUE about it.** Nothing in Step 3 may reduce what the app can find.

#### Step 4's detail

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

## The shape this produces

Four surfaces, each doing the thing it is actually good at:

| Surface | Answers | Source of truth |
|---|---|---|
| **Discover** | which companies are hiring | model + web search |
| **By Role** | which roles match my experience | model + web search, verified per hit |
| **Add by URL** | this specific posting I found myself | the posting itself, paste as fallback |
| **Roles** | what am I actually pursuing | only JD-backed, liveness-checked rows |

The first two FIND. The last two are where truth is established. Nothing in this
document narrows the first two, and every mechanism in it exists to make the fourth
trustworthy enough to act on without re-checking by hand.

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
- Reducing what the app can FIND. Discover and By Role keep their reach; see the
  section above. A design that made the table more trustworthy by making it emptier
  would be solving the wrong problem.

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
- A URL whose page cannot be read still creates a row carrying that URL, and offers
  the paste fallback — it must not silently fail or create a row with no link.
- A role added by URL dedupes against an existing row for the same posting.
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
- **The strongest argument against the whole document** — manual intake gets 100%
  coverage on the roles that matter — is now Step 1 rather than a rejected
  alternative. Refined after discussion into URL-first with paste as the fallback:
  pasted text has no identity, so it cannot be re-checked, deduped, or attributed
  without the user typing what the URL would have supplied.
- **Revision 2 read as though boards replaced search.** They do not, and role-first
  discovery is the surface that would have been silently lost: a board cannot be
  asked which companies are hiring, so By Role is the only way roles at untracked
  companies are ever found. Now stated as its own section and a non-goal.
