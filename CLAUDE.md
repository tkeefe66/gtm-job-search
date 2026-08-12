# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Single-user, AI-powered GTM/RevOps job search tool tuned to Tom Keefe's profile. Next.js 14 (App Router) + TypeScript + Tailwind + Postgres + Anthropic API. No auth, no tests, no API routes — all backend logic is React Server Actions in `app/actions/`.

## Commands

```bash
npm run dev        # local dev server (needs DATABASE_URL + ANTHROPIC_API_KEY in .env.local)
npm run build      # includes typecheck — the verification gate for changes
npm run lint
DATABASE_URL=postgres://... node db/apply-schema.mjs   # apply schema (idempotent)
```

There is no test framework. `npm run build` is the pre-deploy check.

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

## History caveat

The repo was inherited from a previous owner (git history before `d2bed2d` contains his `.claude/skills/` job-search workflow and an accidentally committed `.env.production`). Don't resurrect anything from that era; this app is solely the GTM/RevOps tool described above.
