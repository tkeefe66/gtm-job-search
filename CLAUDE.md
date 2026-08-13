# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Single-user, AI-powered GTM/RevOps job search tool tuned to Tom Keefe's profile. Next.js 14 (App Router) + TypeScript + Tailwind + Postgres + Anthropic API. No auth on the app itself — most backend logic is React Server Actions in `app/actions/`; the one exception is the secret-guarded cron route below.

## Commands

```bash
npm run dev        # local dev server (needs DATABASE_URL + ANTHROPIC_API_KEY in .env.local)
npm run build      # includes typecheck — the verification gate for changes
npm run lint
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

The service is also GitHub-connected (`tkeefe66/chad-job-search`), but repo-triggered deployments sit "Awaiting approval" in the dashboard — `railway up` is the flow actually used. Env vars: `DATABASE_URL` (reference var `${{Postgres.DATABASE_URL}}`) and `ANTHROPIC_API_KEY`, both on the `web` service.

## Architecture

**Every "search" feature is a Claude call with the `web_search` server tool** — there's no scraper. `lib/anthropic.ts` has the two shared helpers: `callWithWebSearch()` (model `claude-sonnet-4-6`) and `parseJson()` (fence-stripping/boundary-finding, because responses aren't strict JSON mode). When adding a web-search call, budget `maxTokens` generously: the model's search narration counts against it, and 2000 tokens has truncated responses before the JSON was emitted (see comment in `app/actions/roles.ts`).

**`lib/supabase.ts` is NOT Supabase** — it's a hand-rolled Supabase-shaped query builder over `pg`, kept so server actions read like Supabase calls. It connects via `DATABASE_URL`. Schema truth is `db/schema.sql` (five tables: `jobs`, `watchlist`, `discovered_roles`, `discovered_startups`, `insights_cache`); `supabase/migrations/` is legacy.

**The fit-scoring brain** is `CANDIDATE_BACKGROUND` + the 1–5 rubric in `app/actions/parse-role.ts` (`scoreFit`). Target role titles and the Denver/remote location filter are duplicated in the prompts in `app/actions/roles.ts` and `app/actions/discover.ts`. Changing what "a good fit" means = edit these prompts, nothing else.

**The Find Roles pipeline** (`findAndSaveRoles` in `app/actions/roles.ts`): one web-search call returns a JSON array of roles → every `job_url` is liveness-checked in parallel (`lib/verify-url.ts` — only definitive 404/410 counts as dead; 403s/timeouts pass through, job boards block bots) → dead roles are saved with status `"Posting Closed"` and skip fit-scoring; live ones are saved as `"New"` and `scoreFit`-ed in parallel. Results are also cached per-company in `discovered_roles` (cache-first unless `force`).

**Status/filter machinery is constant-driven**: `JOB_STATUSES`, `ACTIVE_STATUSES`, `TERMINAL_STATUSES` in `lib/types.ts` drive the dropdown, filter chips, and count buckets in `components/RolesTable.tsx` automatically. To add a status: extend the union + arrays + the `STATUS_STYLES` badge map in `RolesTable.tsx`. The table's default filter is `"Open"` (hides `TERMINAL_STATUSES`).

**Caching pattern**: Discover, Roles, and Insights all cache Claude results in their `*_cache`/`discovered_*` tables and serve those on re-query — API calls only happen on new searches or forced refreshes.

**Tracking and the crawler**: `watchlist` rows with `tracking_enabled = true` are
crawled on a recurring schedule (`crawl_interval_days`, default 7).
`lib/crawler.ts` tries a plain HTTP fetch of `careers_url` and extracts roles
from the stripped text with a non-search Claude call; if `lib/page-extract.ts`
detects a JS-rendered ATS shell it falls back to the `web_search` path. The tier
that worked is remembered in `crawl_method`. `app/api/cron/crawl/route.ts` — the
app's only API route, guarded by `CRON_SECRET` — crawls up to 10 due companies
per call and is invoked daily by the Railway `crawler` cron service. ATS vendor
APIs and job aggregator APIs are deliberately not used.

## History caveat

The repo was inherited from a previous owner (git history before `d2bed2d` contains his `.claude/skills/` job-search workflow and an accidentally committed `.env.production`). Don't resurrect anything from that era; this app is solely the GTM/RevOps tool described above.
