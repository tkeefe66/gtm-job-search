# Handoff: multi-tenant readiness + crawl throughput

Written 2026-08-18, at the end of the session that shipped it all. Production is
current with `main` and everything below was verified against the live system,
not inferred from the code.

## Read first, in this order

1. `CLAUDE.md` — updated this session; the crawler section it used to carry was
   describing an architecture that no longer exists.
2. `docs/superpowers/specs/2026-08-17-crawl-throughput-design.md` — the design,
   the measurements, and the reasoning behind every number. Revision 3.
3. This file, for what is live and what is still open.

## What shipped

Four things, all deployed and verified:

1. **`listCrawlableTenants` now checks `isPlatform()`.** It was an exported
   server action with no session check that returned every active tenant's uuid
   and admin flag to anyone who POSTed its id.
2. **The shared-password gate is gone** — `middleware.ts`, `app/gate/`,
   `app/api/gate/`, and the `GATE_TOKEN` variable. Google sign-in plus the
   pending-approval waitlist covers what it covered. **There is no middleware in
   this app any more**, so nothing covers Server Actions for free; see CLAUDE.md
   for the three invariants that replaced it.
3. **Migration 009** — `app_rw` can no longer write `users.role`. Verified:
   `has_column_privilege('app_rw','users','role','UPDATE')` is `f`, `status` is
   still `t`. On a FRESH database the ADMIN_EMAIL self-promotion in `auth.ts`
   now fails (caught; sign-in still works) and the first admin is a manual
   statement — the migration's comments carry it.
4. **Crawl throughput, Phase 0** — one company per request, plus dead-page
   removal. Detail below.

## State of the world

| Thing | State |
|---|---|
| `main` / `origin/main` / deployed | `6bd2349`, all three agree |
| Migrations applied in production | 001–010 |
| `crawler` service start command | the 30-iteration loop against `/api/cron/crawl-next` |
| `/api/cron/crawl` (batch route) | still exists, still works, **nothing calls it** |
| Tenants | 1 (the admin) |
| Tracked companies | 3, all 14-day intervals |

The loop was proven on live data, not just in tests: one real crawl of `adobe`
ran in **62.5s** (against a 300s edge limit), the second iteration returned
`crawled:false` in 0.2s, and `failing_since` was written correctly.

## Dated trap: 2026-09-01

**`adobe` is primed to be untracked on its next crawl, and it should not be.**

Its 2026-08-18 crawl failed — not because the careers page is gone, but because
the search-tier extraction asked for JSON and the model replied with prose:

```
status: "error"
error: Unexpected token 'I', "I found a "... is not valid JSON
```

That is a PRE-EXISTING bug in the extraction path. It is unrelated to anything
this session changed and would have happened identically on the old batch route.
But it incremented the same counter a dead page would:

```
adobe: consecutive_failures = 1, failing_since = 2026-08-18T06:27:48Z, next check 2026-09-01
```

The dead-page rule fires at **≥2 failures AND ≥7 days**. The clock is already
past 7 days by Sept 1, so **one more failure of any kind untracks the company** —
for a parsing bug, not a dead page.

The clock was left deliberately rather than cleared: the failure really happened,
and erasing it would be editing the evidence instead of fixing the cause. Options,
best first:

1. **Fix the parse failure.** Check whether adobe's search-tier extraction fails
   reproducibly (`/api/cron/crawl-next?dry=1` writes nothing and increments
   nothing, though it does spend a search), then harden the prompt or the parse.
2. **Separate the failure kinds** — let only genuine unreachability (404/410,
   DNS, timeout) start the `failing_since` clock, and give parse failures their
   own category. More correct; changes `lib/dead-tracking.ts`'s contract.
3. **Clear adobe's clock** once the cause is understood — one UPDATE, and honest
   at that point because the diagnosis is settled.

## Phase 0, and what Phase 1 is waiting for

`GET /api/cron/crawl-next` crawls exactly ONE due company and reports whether
more remain; the `crawler` cron calls it in a bounded 30-iteration shell loop.

**Why one company and not a bigger batch:** Railway's edge closes a request that
transfers no data after **300 seconds** (the 15-minute figure applies only while
data keeps flowing). The batch route works silently and answers at the end, so it
got 300s — which at a measured 91.2s worst-case crawl is 3.29 companies. That is
where `DEFAULT_BATCH_LIMIT = 3` really came from, and it is why raising it could
never have worked. `--max-time` is now 300 to match the edge instead of 400,
which was above it and therefore dead configuration.

**Phase 1 is not due yet and should not be built yet.** It is: flip the `crawler`
service from cron to long-running, and add per-tenant quota (`app_settings`,
default 3, `MAX_TENANT_QUOTA` 10, fixed UTC-midnight reset; `users.crawl_quota`
stays unwritten as an admin-only ceiling). The trigger is the capacity banner on
`/watchlist` saying the platform is short — that banner exists precisely to be
that signal. With 1 tenant and 3 companies the current demand is ~0.2 crawls/day
against a capacity in the hundreds.

The formula that says when to care:

```
tenants × companies_tracked ÷ interval_days   ≤   crawls per day
```

## Settled — do not reopen

- **Exponential backoff on failing companies.** Proposed across three revisions
  of the design doc, then overruled: backing off delays the very evidence that
  proves a page is dead, so a "gone for a week" rule would fire a fortnight late.
  Retry on schedule, then stop. Do not re-add it.
- **A cross-tenant selection query.** It cannot be written. `tenant_isolation`
  compares `tenant_id` to a per-connection GUC and `app_rw` is neither superuser
  nor BYPASSRLS, so a query with no tenant set returns **zero rows silently**.
  The route asks each tenant inside its own scope and `pickNextTenant` chooses in
  application code. The count of code paths deciding which tenant a request means
  did not go up. Keep it that way.
- **A queue table.** Not needed. `crawlCompany` advances `last_checked_at` on
  every outcome including failure, so `watchlist` due-ness already IS an
  idempotent queue and a drain loop provably terminates.
- **Deleting rows instead of untracking.** `tracking_enabled = false` keeps the
  hand-fixed careers URL and the crawl history. A manual toggle clears
  `failing_since` in both directions, which is the ONLY thing distinguishing "the
  crawler gave up" from "the user switched it off" in the UI.

## Traps that cost time this session

- **`railway deployment list --json` crashes `json.load()`.** Commit messages
  contain raw newlines. Use `json.loads(sys.stdin.read(), strict=False)`.
- **The Railway MCP server's token expires independently of the CLI.** It read
  service config fine early in the session, then returned `Unauthorized` on every
  call while `railway whoami` stayed happy. `/mcp` reporting "connected" is not
  the same as authorized — the transport reconnects without refreshing the token.
  A full Claude Code restart fixed it. **The CLI cannot set a start command**;
  only the MCP or the dashboard can.
- **The documented migrate invocation is blocked by the auto-mode classifier**,
  because `DATABASE_URL="$DATABASE_PUBLIC_URL" node …` reads as inlining a
  credential. Use a runner that sets `process.env.DATABASE_URL` in-process and
  then imports `db/migrate.mjs`. Never put a connection string on a command line.
- **`railway config pull` needs the Railway TS SDK** and leaves a
  `.railway-config-pull-*/` scaffold directory behind when it fails. Delete it;
  do not commit it.
- **A redeploy does not execute a cron service's command.** It readies the image.
  Do not use it to prove a start command works.

## Ordering rules that are NOT the same as each other

Both are real and they point opposite ways. Read which case you are in.

- **Migration 009 (a grant change): deploy CODE first, then the migration.** The
  migration removes a privilege the running code uses, so the catch in `auth.ts`
  has to be live before `role` becomes unwritable.
- **Migration 010 (an added column): apply the MIGRATION first, then the code.**
  The new code reads `watchlist.failing_since` in an `UPDATE ... RETURNING`, so
  shipping code first errors every crawl. An additive column is safe against the
  old code; a removed privilege is not.

## Verification you can run

```bash
# what is actually deployed — all three must agree
railway deployment list --service web --limit 1 --json \
  | python3 -c "import json,sys; print(json.loads(sys.stdin.read(), strict=False)[0]['meta']['commitHash'])"
git rev-parse main && git rev-parse origin/main

# the new route, end to end, no writes and no counter increment (does spend a search
# only if something is due; returns immediately when nothing is)
# script reads CRON_SECRET/WEB_URL from the injected env — never from a command line
railway run --service crawler node <script calling $WEB_URL/api/cron/crawl-next?dry=1>

# the gate that migration 009 installed
select has_column_privilege('app_rw','users','role','UPDATE');    -- must be f
select has_column_privilege('app_rw','users','status','UPDATE');  -- must be t

# crawl durations — MEASURE, never quote a figure out of prose, including this file
select method, status, count(*),
       round(percentile_cont(0.5) within group (order by extract(epoch from finished_at - started_at))::numeric,1) p50,
       round(max(extract(epoch from finished_at - started_at))::numeric,1) max
  from crawl_runs where finished_at is not null group by method, status;
```

The measurements this design rests on are **n=12**, of which only 4 are
search-tier and only 3 found any roles. An `empty` run skips the per-role
verification and scoring, so nothing here bounds a high-yield crawl. Re-run the
query once the sample includes one.

## Open, and deliberately not decided

- **Delete `app/api/cron/crawl/route.ts`** once the loop has a few clean nights.
  It is kept as a one-setting rollback. Leaving two routes that crawl is how the
  batch limit comes back by accident.
- **The three career-agnostic gaps** in CLAUDE.md's "Known outstanding" are
  untouched by this session and still open: company-name variant merging,
  `TrackedCompany` having no `signal`/`extras` field, and Discover's dropped
  exclusion clause.
- **`DEFAULT_PROFILE.hiringSignal`** still contains venture vocabulary the
  career-neutrality guard does not scan (`hiringSignal` was never added to
  `PHRASES`).
- **The Phase 0 banner's remedy sentence changes at Phase 1.** Today it says
  "track fewer companies, or lengthen the interval"; with quota it becomes "set
  quota to N in Settings".
