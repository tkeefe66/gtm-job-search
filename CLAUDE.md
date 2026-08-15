# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Single-user, AI-powered GTM/RevOps job search tool tuned to Tom Keefe's profile. Next.js 14 (App Router) + TypeScript + Tailwind + Postgres + Anthropic API. No auth on the app itself — most backend logic is React Server Actions in `app/actions/`; the one exception is the secret-guarded cron route below.

## Commands

```bash
npm run dev        # local dev server (needs DATABASE_URL + ANTHROPIC_API_KEY in .env.local)
npm run build      # includes typecheck — the verification gate for changes
npm test           # vitest — pure logic in the crawl path
DATABASE_URL=postgres://... node db/apply-schema.mjs   # apply schema (idempotent)
```

`npm run build && npm test` is the pre-deploy check. Tests cover the pure logic
in the crawl path only (`lib/*.test.ts`) — Claude calls and live fetches are
verified through the Watchlist "Check now" button and the cron route's `?dry=1`
mode. (`npm run lint` is non-functional in this repo — do not add it to the
gate.)

## Deploy

Railway only: project `gtm-job-search`, service `web` (+ Postgres service). Deploy with:

```bash
railway up --service web --detach
```

The service is also GitHub-connected (`tkeefe66/chad-job-search`), but repo-triggered deployments sit "Awaiting approval" in the dashboard — `railway up` is the flow actually used. Env vars on the `web` service: `DATABASE_URL` (reference var `${{Postgres.DATABASE_URL}}`), `ANTHROPIC_API_KEY`, and `CRON_SECRET` (the bearer token `app/api/cron/crawl` requires — auth fails closed, so a deploy missing this value makes every cron run 401 silently, with no log line to point at why). The `crawler` cron service needs the same `CRON_SECRET` value plus `WEB_URL` (the `web` service's public domain).

## Architecture

**Every "search" feature is a Claude call with the `web_search` server tool** — there's no scraper. `lib/anthropic.ts` has the two shared helpers: `callWithWebSearch()` (model `claude-sonnet-4-6`) and `parseJson()` (fence-stripping/boundary-finding, because responses aren't strict JSON mode). When adding a web-search call, budget `maxTokens` generously: the model's search narration counts against it, and 2000 tokens has truncated responses before the JSON was emitted (see comment in `app/actions/roles.ts`).

**`lib/supabase.ts` is NOT Supabase** — it's a hand-rolled Supabase-shaped query builder over `pg`, kept so server actions read like Supabase calls. It connects via `DATABASE_URL`. Schema truth is `db/schema.sql` (eight tables: `jobs`, `watchlist`, `discovered_roles`, `discovered_startups`, `insights_cache`, `crawl_runs`, `role_searches`, `app_settings`); `supabase/migrations/` is legacy.

**Errors are `{ error?: string }` and the string can be EMPTY** — `if (res.error)` reads a
hard failure as a success. `pg` rejects with an `AggregateError` (message `""`) whenever
every address of a dual-stack host refuses, which is what an unset or unreachable
`DATABASE_URL` produces, so the failure mode is "the database is entirely unreachable" and
the symptom is a clean build with a silently wrong screen. Detection is PRESENCE
(`describeWriteFailure(error, "…")` from `lib/write-failure.ts`, then branch on
`!== undefined`); description substitutes only where text is shown. Transports
(`rawQuery`, `readAllSettingsResult`) keep the driver's message verbatim, empty included —
a transport that invents text makes the presence check untestable. An action whose failure
is NOT the database (Claude, parsing) substitutes its own fallback at the catch instead,
because `UNDESCRIBED_DB_ERROR` names the database and would be a false sentence there.
The project skill `.claude/skills/swallowed-string-errors` carries the full contract; two
fresh agents reproduced this defect verbatim without it. Eight instances were found in one
audit and a dedicated sweep still missed four.

**Search criteria are user-editable at `/settings`** — target titles, location terms, GTM stack terms, the location rule, the fit brain, an optional search ceiling, and an optional minimum base compensation. They are stored one row per key in `app_settings` (key/value jsonb, so a new setting needs no migration) and resolved by `loadCriteria()` in `lib/search-criteria.ts`, which overlays saved rows on the shipped `DEFAULT_*` constants in that same file. Nothing is duplicated across prompts any more: every consumer takes the resolved `Criteria` as a parameter. The 1–5 rubric is `buildFitPrompt` in **`lib/fit-prompt.ts`**, not `parse-role.ts`: `"use server"` forbids non-async exports, so nothing in `parse-role.ts` can be exported pure or reached from a test. `scoreFit` itself stays in `app/actions/parse-role.ts` (model, system prompt, JSON parsing) and takes the brain plus the floor as an argument (`FitInputs`, from `loadScoringInputs()`). Changing what "a good fit" means = edit the fit brain on `/settings`, then accept the rescore offer. A save clears only the caches that change invalidates and, for crawler-relevant keys only, stamps `criteria_changed_at` — both decided in `lib/settings-effects.ts`. With `app_settings` empty every search runs on the same criteria it did before the settings page existed, with ONE deliberate exception: the By Role run is now uncapped by default rather than capped at 15 searches (~$1.13 against ~$0.55 — see `MAX_QUERY_MULTIPLIER` below).

**The fit prompt is pinned by checked-in fixtures** (`lib/__fixtures__/fit-prompt.no-floor.txt` and `.with-floor.txt`, rendered from `fit-prompt-inputs.ts`), so any change to the prompt shows up as a diff in the rendered text rather than only in the builder. **Regenerating a fixture requires reading the diff in the same commit** — regeneration blesses whatever the code currently emits, so a commit that touches only fixtures is a red flag, not a routine refresh.

**Compensation**: `salary_range` is stored verbatim as the posting wrote it and parsed at READ time by `parseSalaryRange` in `lib/salary.ts` — base preferred over OTE, so `$280K–$325K (base); $305K–$365K OTE` is a $280–325K role. The optional floor lives in `app_settings` under `compFloor`. It filters `/roles` on DISPLAY only (`lib/salary-filter.ts`: two independent toggles, both off by default; `ote` is its own bucket and is never hidden as "below") — no job is ever dropped or hidden at ingest because of pay. `scoreFit` receives both the posting's stated range and the floor. **The boundary is strict (`>`, not `>=`): a band whose top only REACHES the floor is below it** — `$150K–$200K` fails a $200K floor, `$177K–$221K` clears it. That rule lives in TWO places and they must not drift: `salaryBucketFor` (the display bucket) and `compScoringClause` + `aiGtmCompCarveOut` in `lib/fit-prompt.ts` (the scoring rule). Changing one alone produces a role the table hides while its fit score still reads 4 — and the carve-out needs it too, because it outranks the compensation clause. Because that changed `scoreFit`'s inputs on deploy rather than on an edit, `/settings` offers a one-time rescore gated on the `comp_scoring_rescored_at` stamp (`compRescoreOffer` in `lib/rescore-progress.ts`); the pass itself is `runRescorePass`, never a hand-rolled loop.

**The Find Roles pipeline** (`findAndSaveRoles` in `app/actions/roles.ts`): one web-search call returns a JSON array of roles → the URL-verification and fit-scoring block lives in `lib/ingest-roles.ts` (shared with the crawler and role search below), which liveness-checks every `job_url` in parallel (`lib/verify-url.ts` — only definitive 404/410 counts as dead; 403s/timeouts pass through, job boards block bots), saves dead roles with status `"Posting Closed"` and skips fit-scoring for them, and saves live ones as `"New"`, `scoreFit`-ed in parallel. Results are also cached per-company in `discovered_roles` (cache-first unless `force`).

**Role-first discovery**: `app/actions/role-search.ts` searches for roles by title
and by GTM tool stack (`titleQueries` / `stackQueries` in `lib/search-criteria.ts`)
rather than by company, so companies that never appear in funding news still
surface. How many queries run is decided by `planQueries` in
`lib/search-criteria.ts` from the user's optional search ceiling: with a ceiling
set, `pickQueries` strides the enumeration down to it (advisory — the model
decides what to run) and that same number becomes `callWithWebSearch`'s
`maxSearches`, which sets the `web_search` block's `max_uses` and is the actual
ceiling on billed searches; with no ceiling the full list is offered and
`max_uses` is `MAX_QUERY_MULTIPLIER ×` the query count, a runaway rail rather
than a ration. A stored ceiling below 1 is ignored with a warning.
`maxSearches` is opt-in; the discover, roles, and crawler
callers omit it and are uncapped. Both the sent list and the searches Claude
actually issued are logged. Results cache
in `role_searches` per family and route through the same `lib/ingest-roles.ts`
path as the crawler. The Discover tab has two modes: by company (funding) and
by role.

**Company mode's windows are two independent lists** in `lib/discovery-windows.ts`, and
conflating them is the bug that was just fixed. `FETCHABLE_RANGES` (`7d`, `30d`) is what
the buttons search — one button each, both always visible, each billing its own Claude
run. `PINNED_CHIPS` (`7d`, `30d`, `3m`) is what the filter chip row charts, always shown
even at zero. A chip ONLY slices already-loaded results: selecting one never fetches and
never changes what a button will fetch. `3m` is charted but deliberately unfetchable, and
`6m`/`6-18m` are legacy — their cached results stay visible and filterable, but nothing
can re-fetch them. The invariants between the lists (every fetchable range is also
charted; nothing sits in two lists; the fetchable set is exactly `7d`+`30d`) are pinned by
`lib/discovery-windows.test.ts`, so widening what one click can bill takes a failing test
rather than a quiet line. Wider windows are NOT free: the search prompt is never told what
is already cached and dedupe happens at read time in `getAllDiscoveredStartups`, so a
wider window re-finds and re-bills companies you already have — and it re-tags them to the
newer window, which shifts the chip counts.

**Status/filter machinery is constant-driven**: `JOB_STATUSES`, `ACTIVE_STATUSES`, `TERMINAL_STATUSES` in `lib/types.ts` drive the dropdown, filter chips, and count buckets in `components/RolesTable.tsx` automatically. To add a status: extend the union + arrays + the `STATUS_STYLES` badge map in `RolesTable.tsx`. The table's default filter is `"Open"` (hides `TERMINAL_STATUSES`).

**Caching pattern**: Discover, Roles, and Insights all cache Claude results in their `*_cache`/`discovered_*` tables and serve those on re-query — API calls only happen on new searches or forced refreshes.

**Tracking and the crawler**: `watchlist` rows with `tracking_enabled = true` are
crawled on a recurring schedule (`crawl_interval_days`, default 7).
`lib/crawler.ts` tries a plain HTTP fetch of `careers_url` and extracts roles
from the stripped text with a non-search Claude call; if `lib/page-extract.ts`
detects a JS-rendered ATS shell it falls back to the `web_search` path. The tier
that worked is remembered in `crawl_method`. `app/api/cron/crawl/route.ts` — the
app's only API route, guarded by `CRON_SECRET` — crawls up to 10 due companies
per call and is invoked daily by the Railway `crawler` cron service. **Roles are
never DISCOVERED through ATS vendor or job-aggregator APIs** — the HTML path
works on any careers page, including custom ones and vendors nobody integrated,
and that generality is the point. Link REPAIR is the one narrow exception; see
below.

**Job links rot, and half of them were second-hand.** `checkJobUrl`
(`lib/verify-url.ts`) ran once at ingest and nothing looked again, so closed
postings sat in the table reading "New" indefinitely. Separately, the extraction
schema asked only for `job_url` with no preference, so the model returned
whatever the search engine ranked — 29 of 61 rows were ZipRecruiter/Built
In/Lensa links, which outlive the posting they copy. Both are now addressed:
`roleExtractionSchema()` asks for the employer's own application URL, and
`repairJobLinks()` (`app/actions/link-health.ts`, the "Check links" button)
re-checks every open role. It costs no Claude tokens.

Repair resolves a company's board through the vendors' PUBLIC, unauthenticated
board endpoints (`lib/ats-boards.ts` + `lib/resolve-job-link.ts`) — the
deliberate, narrow exception to the rule above, permitted for link resolution
ONLY and never for discovery. **Every vendor in `BOARD_VENDORS` was
control-tested with a nonsense slug before being added, and nothing may be
added without that test** — two candidates failed it. `jobs.ashbyhq.com/<slug>`
returns 200 for ANY slug because it is a client-rendered SPA (a probe reported
16/16 companies resolved when the truth was 4/16; Ashby is in the list only
because its API is honest even though its HTML is not). SmartRecruiters'
postings endpoint returns 200 with an empty envelope for companies that do not
exist, and is excluded. Absence is therefore checked TWICE, by status and again
by response SHAPE, because each gate alone has a documented way to be fooled.
Workday is excluded for an unrelated reason: its per-tenant site name cannot be
derived from a company name.

Two more traps are pinned by tests. An EMPTY board is not an absent role —
Asseti keeps an empty Breezy board while hiring eight roles through Workable —
so the search continues past one and an empty board can never close anything on
its own. And hosts are matched on a dot boundary in `lib/job-link.ts`, since a
substring check reads a ZipRecruiter link carrying `?utm_source=lever.co` as
the employer's own.

The pass will NOT close a role merely because the employer's board stopped
listing it, even though that is how most of these actually die. The board is
found by GUESSING a slug from the company name, so a collision would close a
live role against a stranger's board. Those rows are reported and handed to the
bulk status control for the user to decide. Only a definitive 404/410 closes
anything, unchanged.

## History caveat

The repo was inherited from a previous owner (git history before `d2bed2d` contains his `.claude/skills/` job-search workflow and an accidentally committed `.env.production`). Don't resurrect anything from that era; this app is solely the GTM/RevOps tool described above.
