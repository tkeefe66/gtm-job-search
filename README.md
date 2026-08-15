# GTM Job Search

<!--
Required environment variables (.env.local):
DATABASE_URL=postgres://user:pass@host:port/db
ANTHROPIC_API_KEY=your_anthropic_api_key
-->

An AI-powered, single-user GTM / RevOps job search tool tuned to Tom Keefe's profile (GTM Systems / RevOps / Marketing Operations leader and AI practitioner-builder). Five tabs:

1. **Discover** — notable AI/tech + B2B SaaS funding rounds (by company), or roles found by title and GTM tool stack (by role). Anthropic web search, cached per query.
2. **Watchlist** — companies you track. Their careers pages are re-crawled on a schedule by a daily cron, so new roles arrive without you searching.
3. **Roles** — the Postgres-backed pipeline. Thirteen statuses (`New`, `Applied`, `Recruiter Outreach`, the interview stages, `Offer`, `Not Interested`, `Rejected`, `Passed`, `Posting Closed`), inline status editing, bulk status changes, fit scores, notes, when each role was found, and **Check links** — see below.
4. **Insights** — analyze your pipeline against the live market and get positioning advice.
5. **Settings** — target titles, locations, GTM stack terms, the location rule, the fit brain, an optional search ceiling, and an optional minimum base compensation. Changing the fit brain here is how you re-tune scoring.

**Everything about targeting is editable at `/settings`** and stored in `app_settings`; the shipped defaults are the `DEFAULT_*` constants in [`lib/search-criteria.ts`](lib/search-criteria.ts), overlaid by `loadCriteria()`. The fit-scoring rubric itself is `buildFitPrompt` in [`lib/fit-prompt.ts`](lib/fit-prompt.ts), pinned by checked-in fixtures.

**Job links are kept honest.** Roles found through a job aggregator are resolved to the employer's own posting where possible, and roles whose posting has closed are detected and marked — on ingest, from the daily cron, and from the **Check links** button. This costs no Anthropic credits: it uses HTTP plus the ATS vendors' public job-board endpoints. See `CLAUDE.md` for the rules, which are narrower than they look.

## Stack

Next.js 14 (App Router) · TypeScript · Tailwind · Postgres (via `pg`) · Anthropic API (`claude-sonnet-4-6`, web search tool) · Railway.

The data layer lives in [`lib/supabase.ts`](lib/supabase.ts) — a small Supabase-compatible query builder over `pg` (the file keeps the `supabase` name so the server actions didn't have to change). The canonical schema is [`db/schema.sql`](db/schema.sql). All Anthropic calls run server-side (server actions); the API key is never exposed client-side.

## Setup

### 1. Install

```bash
npm install
```

### 2. Set environment variables

Copy the values into `.env.local` (use your Postgres database's **public** URL for local dev):

```
DATABASE_URL=postgres://user:pass@host:port/db
ANTHROPIC_API_KEY=your_anthropic_api_key
```

### 3. Apply the schema

```bash
DATABASE_URL=postgres://... node db/apply-schema.mjs
```

Applying it to the Railway database **from your machine** needs the Postgres
service's public URL with a specific suffix:

```bash
DATABASE_URL="$(railway variables --service Postgres --kv | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-)?uselibpqcompat=true&sslmode=require" \
  node db/apply-schema.mjs
```

Without `uselibpqcompat=true` this fails with `self-signed certificate in
certificate chain`. Recent `pg` treats a bare `sslmode=require` as
`verify-full`, which overrides the script's own `rejectUnauthorized: false`;
`uselibpqcompat=true` restores libpq semantics. The plain `DATABASE_URL` on the
`web` service will not work from a laptop at all — it resolves to Railway's
private network.

This creates all eight tables (`jobs`, `watchlist`, `discovered_roles`, `discovered_startups`, `insights_cache`, `crawl_runs`, `role_searches`, `app_settings`) and applies any new columns. It's idempotent — safe to re-run, and it must be re-run before deploying code that reads or writes a column added since the last run. Single-user tool, so there's no auth/RLS; put it behind auth if you expose it publicly.

### 4. Run locally

```bash
npm run dev
```

Open http://localhost:3000.

## Deploy to Railway

Deployed as the `web` service in the `gtm-job-search` Railway project, with a managed Postgres database in the same project.

1. `DATABASE_URL` on the `web` service is a reference to the Postgres service (`${{Postgres.DATABASE_URL}}`) — uses Railway's private network.
2. Set `ANTHROPIC_API_KEY` and `CRON_SECRET` on the `web` service. `CRON_SECRET` guards `app/api/cron/crawl`, and its auth fails closed — a deploy missing it makes every cron run 401 silently.
3. `railway up --service web --detach` to deploy. Railway (Nixpacks) runs `npm run build` then `npm run start`. **`--service web` is not optional**: the linked service is usually `crawler`, and a bare `railway up` deploys the app over the cron service.

A separate `crawler` cron service calls that route daily; it needs the same `CRON_SECRET` plus `WEB_URL`.

## Build

```bash
npm run build
```
