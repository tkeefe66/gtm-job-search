---
name: spend-and-crawl-diagnostics
description: Use when a user reports unexpected spend, a billing charge, or crawler activity in this app and asks what caused it, or asks why/when a watchlist company was (or wasn't) crawled. Also use when reading `usage_events`, `usage_counters`, `crawl_runs`, or `watchlist.crawl_interval_days`/`last_checked_at` to explain a charge, and when checking the `crawler` service's actual cron cadence.
---

# Spend and Crawl Diagnostics

## Overview

Billing and crawl-cadence questions ("why did I get charged", "is X crawling too
often") can't be answered by reading code alone — `crawl_interval_days` has no audit
trail, so you have to reconstruct cause from live rows and logs. This is that
reconstruction, in order.

**REQUIRED SUB-SKILL:** railway-cli — for `DATABASE_PUBLIC_URL` / no-inline-credential
rules on one-off queries, and for reading a service's live cron schedule via
`railway status --json`.

## Steps

1. **Resolve tenant.** `select id, email, monthly_budget_cents, daily_budget_cents from users where email = $1`. Everything below is scoped to this `tenant_id`.

2. **Find the charge.** Query `usage_events` (`occurred_at`, `action`, `searches`, `input_tokens`, `output_tokens`, `cost_cents`) for the tenant over the window in question, and `usage_counters` (`period` = `YYYY-MM-DD` / `YYYY-MM`) for the running totals. `action` tells you the trigger — don't guess:
   - `crawl` — automated cron (`app/api/cron/crawl-next`), not the user
   - `crawl-now` — the Watchlist "Check now" button, the user
   - `discover`, `role-search`, `onboarding`, `rescore` — other billed actions, self-explanatory by name

3. **Explain a `crawl`/`crawl-now` cost.** Join to `crawl_runs` (`method`: `'fetch'` is near-free; `'search'` is the expensive tier, ~$1+/run because the careers page needed the `web_search` fallback — see `lib/page-extract.ts`). Then check `watchlist` for that company: `crawl_interval_days`, `last_checked_at`, `tracking_enabled`. Due-ness is exactly:
   ```sql
   last_checked_at is null or last_checked_at <= now() - (crawl_interval_days || ' days')::interval
   ```
   (`lib/crawl-schedule.ts`, `DUE_COMPANIES_SQL`). Only ONE company gets crawled per tenant per cron trigger — the shell loop stops at the first `crawled=false`.

4. **No audit trail on `crawl_interval_days`.** You can read its *current* value and the full `crawl_runs` history, but not when it was last edited (`setCrawlInterval` in `app/actions/watchlist.ts` does a plain UPDATE, no history row). If the observed gap between two `crawl_runs` rows for a company is inconsistent with its current `crawl_interval_days`, the honest conclusion is "the interval was likely different when this fired and has since changed" — verify against `railway logs --service crawler` (step 5) rather than asserting a specific prior value you can't prove.

5. **Confirm against ground truth.** `railway status --json` for the `crawler` service's `cronSchedule`/`nextCronRunAt` (see railway-cli), then `railway logs --service crawler` — each cron trigger logs one line per company: `crawled=true company="..." result={...} tenantsWithWork=N`, ending in `crawled=false tenantsWithWork=0`. This is the only reliable record of what the scheduler actually picked on a given day; use it to sanity-check the due-date math in step 3 rather than trusting the current `crawl_interval_days` value alone.

## Query template

```js
// scratch/spend-check.mjs — see railway-cli skill for the DATABASE_PUBLIC_URL / railway run pattern
import pg from "/abs/path/to/repo/node_modules/pg/lib/index.js"
const client = new pg.Client({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL })
await client.connect()
const { rows: [user] } = await client.query(`select id from users where email = $1`, [email])
const { rows: events } = await client.query(
  `select occurred_at, action, searches, input_tokens, output_tokens, cost_cents
     from usage_events where tenant_id = $1 order by occurred_at desc limit 20`,
  [user.id]
)
```

## Common mistakes

- Assuming `action = 'crawl'` was the user clicking something — it's the cron; `'crawl-now'` is the manual trigger.
- Trusting the current `crawl_interval_days` as "what it always was" when explaining a past run — there's no history for that column.
- Looking for cron cadence in a repo config file — this repo has none; it's Railway platform config, read via `railway status --json` (see railway-cli).
