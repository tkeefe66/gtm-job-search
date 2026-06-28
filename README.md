# Job Search Reconciler

<!--
Required environment variables (.env.local):
NEXT_PUBLIC_SUPABASE_URL=your_supabase_project_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
ANTHROPIC_API_KEY=your_anthropic_api_key
-->

An AI-powered, single-user product job search tool. Four phases:

1. **Discover** — find this week's notable AI/tech startup funding rounds (Anthropic web search).
2. **Roles** — for any company, surface open VP/CPO/Director/Senior PM roles with fit signals.
3. **Tracker** — a Supabase-backed pipeline (Tracking → Applied → Interviewing → Offer → Passed) with inline status, fit-score stars, and notes.
4. **Insights** — analyze your pipeline vs. the live market and get positioning advice.

## Stack

Next.js 14 (App Router) · TypeScript · Tailwind · Supabase · Anthropic API (`claude-sonnet-4-6`, web search tool) · Vercel.

All Anthropic calls run server-side (server actions). The API key is never exposed client-side.

## Setup

### 1. Clone & install

```bash
git clone https://github.com/chadholdorf/job-search-reconciler.git
cd job-search-reconciler
npm install
```

### 2. Set environment variables

Copy the values into `.env.local`:

```
NEXT_PUBLIC_SUPABASE_URL=your_supabase_project_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
ANTHROPIC_API_KEY=your_anthropic_api_key
```

### 3. Run the Supabase migration

In the Supabase dashboard → SQL Editor, paste and run the contents of
[`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql).

This creates the `jobs` table. Since this is a single-user tool, Row Level
Security is left off (the anon key has full access). If you deploy publicly,
enable RLS or put the app behind auth.

### 4. Run locally

```bash
npm run dev
```

Open http://localhost:3000.

## Deploy to Vercel

1. Push to GitHub (`main` auto-deploys).
2. In the Vercel project → Settings → Environment Variables, add:
   - `ANTHROPIC_API_KEY`
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
3. Redeploy. `vercel.json` references these as the build env.

## Build

```bash
npm run build
```
