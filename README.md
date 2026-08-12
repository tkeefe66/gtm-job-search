# GTM Job Search

<!--
Required environment variables (.env.local):
DATABASE_URL=postgres://user:pass@host:port/db
ANTHROPIC_API_KEY=your_anthropic_api_key
-->

An AI-powered, single-user GTM / RevOps job search tool tuned to Tom Keefe's profile (GTM Systems / RevOps / Marketing Operations leader and AI practitioner-builder). Four phases:

1. **Discover** — find this week's notable AI/tech + B2B SaaS startup funding rounds (Anthropic web search).
2. **Roles** — for any company, surface open GTM Systems / RevOps / Marketing Ops / GTM-AI / GTM Engineer roles (VP/Head · Director · Senior Manager · Manager/IC) with fit signals.
3. **Tracker** — a Postgres-backed pipeline (Tracking → Applied → Interviewing → Offer → Passed) with inline status, fit-score stars, and notes.
4. **Insights** — analyze your pipeline vs. the live market and get positioning advice.

The candidate profile that drives fit-scoring lives in `app/actions/parse-role.ts` (`CANDIDATE_BACKGROUND`); the target-role titles and Denver/remote location filter live in `app/actions/roles.ts` and `app/actions/discover.ts`.

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

This creates all five tables (`jobs`, `watchlist`, `discovered_roles`, `discovered_startups`, `insights_cache`). It's idempotent — safe to re-run. Single-user tool, so there's no auth/RLS; put it behind auth if you expose it publicly.

### 4. Run locally

```bash
npm run dev
```

Open http://localhost:3000.

## Deploy to Railway

Deployed as the `web` service in the `gtm-job-search` Railway project, with a managed Postgres database in the same project.

1. `DATABASE_URL` on the `web` service is a reference to the Postgres service (`${{Postgres.DATABASE_URL}}`) — uses Railway's private network.
2. Set `ANTHROPIC_API_KEY` on the `web` service.
3. `railway up --service web` to deploy. Railway (Nixpacks) runs `npm run build` then `npm run start`.

## Build

```bash
npm run build
```
