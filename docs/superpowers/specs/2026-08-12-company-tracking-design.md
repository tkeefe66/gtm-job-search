# Company Tracking + Role-First Discovery — Design

Date: 2026-08-12
Status: Approved for planning

## Problem

Company discovery today has one entry point: `discoverStartups` asks Claude to find
Series B+ funding rounds from the last 7d/30d/3m/6m. The universe is therefore
"companies that announced a large round recently and got press for it." Two
consequences:

1. **Timing is wrong.** A company that closed a Series B last week has no RevOps req.
   The company hiring GTM Systems today raised 9-18 months ago.
2. **Reach is wrong.** Companies hiring these roles that are bootstrapped, PE-backed,
   public, or simply past their press cycle never enter the funnel. Neither do
   Denver-local companies of any stage.

Meanwhile a company only gets re-checked for roles when the user manually clicks
"Find roles" on the Discover tab. The `watchlist` table has a `last_checked_at`
column that is written by `markChecked` and read by nothing. Watching a company
currently does nothing except hide it from the Discover list.

## Goals

- The user can say "track company X" for any company, whether or not it ever
  appeared in Discover, and that company's careers page is checked on a recurring
  schedule until the user stops tracking it.
- New roles found by a check land in the Roles table already fit-scored, without
  the user doing anything.
- The user can search for roles by title and by GTM tool stack, independent of
  funding news, and track any company those searches surface.
- Checking a tracked company costs materially less than the current
  `findAndSaveRoles` path (~10+ billed web searches per company).

## Non-goals

- ATS vendor APIs (Greenhouse/Lever/Ashby job board APIs). Verified during design:
  these are per-tenant and there is no cross-customer endpoint
  (`boards-api.greenhouse.io/v1/boards` returns 404). Ruled out by the user
  regardless. The crawler treats every careers page as an ordinary web page.
- Third-party job aggregator APIs (SerpApi, Adzuna, and similar). Ruled out.
- Multi-user support. This remains a single-user app with no auth.
- Changing the fit-scoring rubric or `CANDIDATE_BACKGROUND`.

## Decisions taken during design

| Decision | Choice |
|---|---|
| Scope | Tracking/crawl and role-first discovery in one spec. They share the role-ingestion path. |
| Tracking store | Extend the existing `watchlist` table. "Watching" comes to mean "actively crawled." |
| Crawl method | HTTP fetch first, Claude web_search as fallback. Claude extracts in both paths. |
| New roles | Auto-added as `New` and fit-scored, matching current `findAndSaveRoles` behavior. |
| Scheduler | Railway cron service calling an authenticated Next route handler (option A). |
| Tests | Add vitest, covering the pure logic only. |

---

## 1. Data model

### 1.1 `watchlist` gains tracking columns

Additive and idempotent, appended to `db/schema.sql`:

```sql
alter table watchlist add column if not exists tracking_enabled      boolean not null default true;
alter table watchlist add column if not exists crawl_method          text;
alter table watchlist add column if not exists crawl_interval_days   integer not null default 7;
alter table watchlist add column if not exists last_crawl_status     text;
alter table watchlist add column if not exists last_crawl_error      text;
alter table watchlist add column if not exists consecutive_failures  integer not null default 0;
alter table watchlist add column if not exists source                text;
```

- `tracking_enabled` — untracking sets this to `false` rather than deleting the row,
  so crawl history survives and the company does not resurface in Discover as
  though it were newly found. Hard delete stays available as a separate action.
- `crawl_method` — `'fetch'` or `'search'`, learned from the first successful crawl
  so later cycles skip straight to the tier that works. `null` until learned.
- `last_crawl_status` — `'ok' | 'empty' | 'error' | 'needs_url'`.
- `source` — `'discover' | 'manual' | 'role-match'`, so the user can see which
  signal produced each tracked company.

Existing rows get `tracking_enabled = true` by the column default. Companies
already on the watchlist begin being crawled after deploy, which is the intended
behavior.

### 1.2 New `crawl_runs` table

```sql
create table if not exists crawl_runs (
  id           uuid primary key default gen_random_uuid(),
  company      text not null,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  method       text,
  roles_found  integer not null default 0,
  new_roles    integer not null default 0,
  role_titles  jsonb not null default '[]',
  status       text not null,
  error        text
);
create index if not exists crawl_runs_company_idx on crawl_runs (company, started_at desc);
```

One row per crawl attempt. This is the audit trail that answers "why has this
company gone quiet" — without it, a silently failing crawler is indistinguishable
from a company that genuinely is not hiring.

`role_titles` holds the normalized titles seen on that run. It exists so stale-posting
closure (§3.3) can compare consecutive successful runs; counts alone cannot tell you
*which* role disappeared.

### 1.3 Role deduplication

No new fingerprint table. Dedupe runs against the existing `jobs` table on
`(company, lower(trim(role_title)))`, with `job_url` as a secondary match for
retitled postings.

Dedupe deliberately ignores `status`. A role the user already marked `Rejected` or
`Not Interested` must never be re-added as `New` by a later crawl.

---

## 2. Shared modules

### 2.1 `lib/search-criteria.ts` (new)

Single home for the target titles and the Denver/remote location filter, which
CLAUDE.md records as currently duplicated across the prompts in `roles.ts` and
`discover.ts`. This spec adds two more prompts; without extraction they would be
duplicated four ways.

Exports:

- `TARGET_TITLES: string[]` — Head/VP/Director of GTM Systems, RevOps, Revenue
  Operations, Marketing Operations, GTM Strategy, GTM/AI Operations, GTM Engineer,
  AI-Ops practitioner-builder.
- `GTM_STACK_TERMS: string[]` — Salesforce, HubSpot, Clay, Gong, Outreach,
  Marketo, and similar. Used by stack-based role search.
- `LOCATION_RULE: string` — the prose location filter (fully remote OR at least one
  listed location in Denver/Boulder/Colorado Springs/Fort Collins, CO).
- `roleExtractionSchema(): string` — the shared prose description of the JSON role
  object (`role_title`, `job_url`, `location`, `seniority`, `salary_range`,
  `description_summary`, `fit_signal`, `ic_flag`) so all callers request one shape.

Existing prompts in `roles.ts` and `discover.ts` are rewritten to compose from
these constants. Prompt wording is preserved as closely as possible; this is
deduplication, not retuning.

### 2.2 `lib/ingest-roles.ts` (new)

Extracted from the inline block currently at `app/actions/roles.ts:100-143`.

```ts
ingestRoles(opts: {
  company: string;
  roles: Role[];
  companyContext: { tagline?, traction?, careers_url?, category?, raised?, stage? };
  source: string;             // 'Discover' | 'Crawl' | 'Role Search'
  dryRun?: boolean;
}): Promise<{ added: Role[]; skipped: Role[]; closed: string[] }>
```

Pipeline, unchanged in behavior from today except for the added dedupe step:

1. Dedupe against `jobs` (§1.3). Already-known roles are returned in `skipped`.
2. Verify each new role's `job_url` via `checkJobUrl` in parallel.
3. `addJob` with status `Posting Closed` for dead URLs, `New` otherwise.
4. `scoreFit` in parallel for live roles, then `updateJob` with score and rationale.

`dryRun: true` performs steps 1-2 and returns what it would do without writing.

Three callers: Discover's Find Roles, the crawler, and role-first search.

### 2.3 `lib/anthropic.ts` gains `callStructured`

```ts
callStructured(opts: { system: string; prompt: string; maxTokens?: number }): Promise<string>
```

Identical to `callWithWebSearch` minus the `tools` array — a plain completion with
no web search. Reports usage through the same `report()` call. This is what makes
the fetch tier cheap: extraction from already-fetched page text needs no search.

---

## 3. The crawler

`lib/crawler.ts`, exporting `crawlCompany(company: string, opts?: { dryRun?: boolean })`.

### 3.1 Sequence

1. **Load** the watchlist row. Abort if missing or `tracking_enabled = false`.
2. **Open** a `crawl_runs` row with `status = 'running'`.
3. **Resolve `careers_url`** if absent — one `callWithWebSearch` call asking for the
   company's careers page URL. Store it on the watchlist row. If it cannot be
   resolved, finish with `status = 'needs_url'` and stop; the UI then asks the user
   to paste one.
4. **Fetch** `careers_url` — browser User-Agent, `redirect: 'follow'`, 10s
   `AbortController` timeout, mirroring `lib/verify-url.ts`. Non-2xx or network
   error falls through to the search tier.
5. **Strip** the HTML to text: drop `<script>`, `<style>`, `<svg>`, `<nav>`,
   `<footer>`; collapse whitespace; retain anchor `href` values alongside their
   text so job links survive stripping. Truncate to 40,000 characters.
6. **Shell detection** — `isJsShell(strippedText, links)` returns true when the
   stripped text is under 500 characters or fewer than 3 links match job-like href
   patterns (`/job`, `/jobs/`, `/careers/`, `/position`, `/opening`, `gh_jid=`,
   `/apply`). True means the page is a JS-rendered ATS embed with no content in the
   HTML; go to the search tier.
7. **Extract (fetch tier)** — `callStructured` over the stripped text, asking for
   roles matching `TARGET_TITLES` and `LOCATION_RULE` in the shape from
   `roleExtractionSchema()`. `maxTokens: 4000`.
8. **Search tier (fallback)** — `callWithWebSearch` scoped to the company, the
   prompt currently in `roles.ts:56`, `maxTokens: 8000`.
9. **Ingest** via `ingestRoles` with `source: 'Crawl'`.
10. **Close stale postings** (§3.3).
11. **Record** results: update `crawl_runs`, set `last_checked_at`, `crawl_method`,
    `last_crawl_status`, reset or increment `consecutive_failures`.

`crawl_method` is honored on later runs: `'search'` skips steps 4-7 entirely. A
`'fetch'` company that later returns a shell falls back and re-learns `'search'`.

### 3.2 Politeness

One request per company per crawl, one crawl per company per `crawl_interval_days`
(default 7). Honest User-Agent identifying the tool. `robots.txt` is fetched and
cached per host for the duration of a batch; a `Disallow` covering the careers path
skips the fetch tier and goes straight to search.

### 3.3 Closing stale postings

A role in `jobs` for this company with an active status, absent from the crawl
results, is a candidate for closure. It is only marked `Posting Closed` after
**two consecutive successful crawls** in which it was absent — determined by
checking the role's normalized title against `role_titles` on the two most recent
`crawl_runs` rows for that company with `status = 'ok'`. Crawls with
`status` of `error`, `empty`, or `needs_url` never close anything. A fetch failure
must never mark a live job closed.

### 3.4 Cost

The fetch tier replaces roughly ten billed web searches plus one Claude call with a
single Claude call over already-fetched text. Companies whose careers pages render
server-side settle on `crawl_method = 'fetch'` after the first cycle and stay
cheap. JS-rendered boards cost the same as today's manual Find Roles, but only once
per interval instead of on every user click.

---

## 4. Scheduling

### 4.1 Route handler

`app/api/cron/crawl/route.ts` — the app's first API route.

- `GET`, guarded by `Authorization: Bearer <CRON_SECRET>` using a constant-time
  comparison. Any mismatch returns 401 with no body. The guard matters because this
  route both mutates the database and spends Anthropic credits.
- Selects tracked companies that are due:
  `tracking_enabled = true AND (last_checked_at IS NULL OR last_checked_at < now() - crawl_interval_days * interval '1 day')`,
  ordered by `last_checked_at` nulls first, limited to `BATCH_LIMIT = 10`.
- Crawls them sequentially. One company's failure never aborts the batch.
- `?dry=1` runs the full pipeline with `dryRun: true` and writes nothing.
- Returns JSON: per-company `{ company, method, roles_found, new_roles, status, error }`
  plus batch totals.

Sequential rather than parallel: the batch limit combined with a daily schedule
means throughput is adequate, and sequential execution keeps the request inside
normal HTTP timeouts and avoids bursting the Anthropic API.

### 4.2 Railway wiring

A new `crawler` cron service in the existing `gtm-job-search` project, scheduled
daily, whose command is a `curl` against the `web` service's route with the bearer
secret. `CRON_SECRET` is set on both services.

With `BATCH_LIMIT = 10`, a daily cron, and a 7-day default interval, the scheduler
sustains 70 tracked companies. Beyond that, companies age past their interval and
are picked up in `last_checked_at` order, so nothing starves — checks just stretch
out. Raising `BATCH_LIMIT` is the lever if the list grows.

Confirm the target service before the first deploy, per the global Railway rule.

---

## 5. Role-first discovery

`app/actions/role-search.ts`, exporting `findRolesByCriteria(opts)`.

Two query families, both built from `lib/search-criteria.ts`:

- **Title queries** — target titles crossed with the location rule
  (`"GTM Engineer" Denver`, `"Revenue Operations" remote`). Catches roles named the
  way the user expects.
- **Stack queries** — GTM tool names crossed with hiring language
  (`"Clay" "Salesforce" hiring remote`). Catches roles with idiosyncratic titles —
  Business Systems Manager, Growth Systems Lead — that title search structurally
  misses. Titles in this function vary; the tooling does not.

One `callWithWebSearch` per family, each instructed to run several searches and
return a flat JSON array of roles that each carry a `company` field.
`maxTokens: 8000`, matching the budget note in `roles.ts:61`.

Results route through `ingestRoles` with `source: 'Role Search'`. Companies not
already in `watchlist` are returned as suggestions; the user tracks them with one
click, recorded as `source = 'role-match'`.

Results are cached in `discovered_startups`-style fashion: a new `role_searches`
table keyed on the query family and search term, holding the raw role array and
`fetched_at`, so reopening the tab does not re-spend API calls. This follows the
caching pattern already used by Discover, Roles, and Insights.

```sql
create table if not exists role_searches (
  id          uuid primary key default gen_random_uuid(),
  family      text not null,          -- 'title' | 'stack'
  search_term text not null default '',
  roles       jsonb not null default '[]',
  fetched_at  timestamptz default now(),
  unique (family, search_term)
);
```

---

## 6. UI

Nav is unchanged — four tabs.

### 6.1 Watchlist page (`components/Watchlist.tsx`)

- **"Track a company" input** at the top. Free text, any company name, no
  requirement that it appeared in Discover. On submit: insert with
  `source = 'manual'`, resolve `careers_url`, and run the first crawl immediately
  so the user sees a result rather than waiting a day.
- Each row shows last checked, next check due, last crawl status, and the count of
  roles found on the last successful crawl.
- **Check now** button per row, calling the same `crawlCompany` the cron uses.
- **Stop tracking** flips `tracking_enabled`. A stopped company stays visible in a
  collapsed "Not tracked" section with a Resume button.
- A company with `consecutive_failures >= 3` shows a warning badge with
  `last_crawl_error`, and `needs_url` shows an inline field to paste a careers URL.
  Tracking is never disabled automatically — that promise is the user's to break.

### 6.2 Discover page (`components/Discover.tsx`)

Two modes behind a toggle:

- **By company (funding)** — existing behavior plus one new date range. The
  `DateRange` union gains `"6-18m"`, labeled "6–18 mo", which becomes the default
  selection; `DATE_RANGE_LABELS` maps it to "between 6 and 18 months ago". The
  existing `7d`/`30d`/`3m`/`6m` options are unchanged and still available. This
  targets the window in which a company that raised actually opens GTM systems
  reqs, without removing the ability to look at fresh news. Cached results are
  keyed on `date_range`, so the new range starts with an empty cache and does not
  disturb existing rows.
- **By role (title/stack)** — runs `findRolesByCriteria`, lists matched roles
  grouped by company, with a Track button on each company.

---

## 7. Error handling

Every failure is recorded; none are silent.

| Failure | Behavior |
|---|---|
| `careers_url` unresolvable | `status = 'needs_url'`, UI prompts for manual entry, `consecutive_failures` incremented |
| Fetch non-2xx / timeout / network error | Logged, falls through to search tier — not itself a failure |
| Both tiers return no roles | `status = 'empty'`, `consecutive_failures` reset to 0 (a real "nothing open" answer) |
| Claude call throws | `status = 'error'`, message stored in `last_crawl_error`, `consecutive_failures` incremented, retried next cycle |
| `parseJson` throws | Treated as `error`; raw response head logged for diagnosis |
| One company fails mid-batch | Recorded, batch continues |
| 3+ consecutive failures | Warning badge in UI; crawling continues |

Error messages follow the global rule — what failed, why, what to try. The cron
route's JSON response surfaces per-company errors rather than a bare count.

---

## 8. Testing

Vitest is added to a repo that currently has no test framework. Scope is
deliberately narrow: the pure logic in the crawl path, where a bug is *silent*. If
`isJsShell` breaks, the crawler stops falling back to search and reports "no roles"
every week for every company, which is indistinguishable from a quiet job market.

- `vitest` devDependency, `vitest.config.ts` with the `@/` alias and `node`
  environment (no jsdom — no component tests), `"test": "vitest run"` in
  package.json.
- Tests cover: `isJsShell` (populated page vs empty ATS embed), the HTML stripper's
  link retention, the dedupe key (case/whitespace normalization, and that a
  `Rejected` job still suppresses re-adding), due-company selection
  (null `last_checked_at` first, interval respected), and the criteria query
  builders.
- Not covered: Claude calls, live HTTP fetches, end-to-end crawls. Those are
  verified through **Check now** and the `?dry=1` cron mode.

Pre-deploy gate becomes `npm run build && npm test && npm run lint`.

---

## 9. Implementation order

1. Schema — new columns, `crawl_runs`, `role_searches`; apply via `db/apply-schema.mjs`.
2. Vitest setup.
3. `lib/search-criteria.ts` + rewrite existing prompts to compose from it. Verify
   Discover and Find Roles still behave.
4. `lib/ingest-roles.ts` extracted from `roles.ts`; `roles.ts` switched to it.
5. `lib/anthropic.ts` — `callStructured`.
6. `lib/crawler.ts` with its unit tests.
7. Watchlist server actions — track, untrack, manual add, check now.
8. `components/Watchlist.tsx` tracking UI. **First user-visible checkpoint.**
9. `app/api/cron/crawl/route.ts` + `CRON_SECRET`; verify with `?dry=1`.
10. Railway cron service.
11. `app/actions/role-search.ts` + `role_searches` caching.
12. `components/Discover.tsx` two modes + funding-window change.

Steps 1-10 deliver tracking end to end. Steps 11-12 add role-first discovery on top
of the ingestion path built in step 4.

## 10. Risks

- **Careers-page extraction quality varies.** Some pages list every role including
  engineering; the extraction prompt filters by title and location, so over-broad
  pages cost tokens rather than producing noise. `?dry=1` on a sample of tracked
  companies before enabling the cron is the check.
- **Auto-add creates noise if a crawl over-matches.** Mitigated by dedupe and by
  the Roles table's existing default `Open` filter. If it becomes a problem, the
  review-queue alternative considered during design remains available.
- **Cron throughput ceiling** at ~70 tracked companies with the default settings.
  Documented above; `BATCH_LIMIT` is the lever.
- **First API route in an app with no auth.** The bearer secret is the only thing
  standing between a public URL and unbounded API spend. It must be a long random
  value, and the route must not log it.
