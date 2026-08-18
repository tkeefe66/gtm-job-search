# Crawl throughput for 10–25 tenants

**Status:** design only. Nothing here is implemented, and nothing should be
until Tom picks an approach. Written 2026-08-17.

**Target, set by Tom:** 10–25 tenants within 6–12 months; each tenant gets a
guaranteed nightly crawl quota, defaulting to 3 and settable per tenant; no
constraint on infrastructure beyond stating what it costs to run.

---

## 1. The premise was wrong, and the measurement is why

Every previous discussion of this problem — `lib/crawl-schedule.ts`'s comment,
`lib/crawl-fairness.ts`'s header, `CLAUDE.md`, and the task that commissioned
this doc — rests on one number: *a search-tier crawl takes 60–120s, so ten
companies in one sequential request is 10–20 minutes.* That number was never
measured. `lib/crawl-schedule.ts` says so in as many words: "raise it once that's
known."

It is knowable. `crawl_runs` has `started_at` and `finished_at` on every attempt.
Queried against the production database on 2026-08-17:

| method | status | n | min | p50 | p95 | max |
|---|---|---:|---:|---:|---:|---:|
| fetch | empty | 7 | 1.0s | 2.8s | 5.9s | 5.9s |
| fetch | ok | 1 | 8.8s | 8.8s | 8.8s | 8.8s |
| search | empty | 2 | 65.5s | 68.3s | 70.9s | 71.2s |
| search | ok | 2 | 39.3s | 65.3s | 88.7s | 91.2s |

Blended across all 12: **p50 5.9s, p95 80.2s, max 91.2s.**

Three things follow, and they point in different directions.

**The 60–120s figure describes the search tier only, and overstates even that.**
The observed search-tier maximum is 91.2s, not 120s. Two thirds of runs (8 of 12)
took the fetch tier and finished in under 9 seconds. A batch of 3 costs about 18
seconds at the blended median, not the ~6 minutes the constant was sized against.

**The variance, not the mean, is the thing to design around.** The two tiers are
roughly 15× apart, and which tier a company takes is not random — `crawl_method`
is remembered per company, so a tenant tracking JS-rendered ATS shells is
all-search-tier every night while another is all-fetch. Sizing a batch by an
average is therefore sizing it for a tenant who does not exist. Any design whose
failure unit is "the batch" inherits the worst tenant's profile; a design whose
failure unit is "one company" is bounded by 91s regardless of the mix.

**Now the caveats, because n=12 is not a measurement so much as a hint.**

- Twelve runs over five days, of which only **4 are search tier** and only **3
  found any roles at all** (`status = ok`). The p95 is computed over a sample too
  small to have a meaningful 95th percentile; read the `max` column and ignore
  the p95.
- Seven of twelve runs were `status = empty`, and an empty run **skips the
  expensive part** — URL liveness verification and fit-scoring run per role
  found, so a company returning 20 new roles does work no measured run did. The
  slowest observed run (91.2s) did find roles, so the tier cost is real, but
  nothing here bounds a high-yield crawl. **Assume the true tail is above 91s and
  design so that the tail costs one company, not one batch.**
- Every one of these runs happened with one tenant and three tracked companies.
  Nothing here has been observed under contention.

**Current state, for the record:** 1 active user, 8 watchlist rows of which 3 are
tracked, all three at `crawl_interval_days = 14` — not 7. The interval that
"slips immediately" is not currently set to 7 by anyone.

## 2. What actually constrains the design

Not Claude spend. Every non-admin tenant supplies their own API key
(`tenant_api_keys`), and the crawl is already metered through `withBudget`, which
skips a capped tenant rather than failing it. Adding throughput spends the
tenant's own money against their own budget ceiling. **Wall-clock and failure
granularity are the constraints, not cost.**

The real ceiling today is a chain of three:

1. **`DEFAULT_BATCH_LIMIT = 3`** — platform-wide, not per tenant.
   `splitCrawlBatch` divides those 3 slots round-robin across all active tenants,
   rotated by day number so the tenant who misses out changes nightly. With 2
   tenants each gets ~10 crawls a week; with 25 tenants each gets ~0.8.
2. **One HTTP request holds the entire nightly run.** The route loops tenants,
   and within each tenant loops companies, sequentially, in a single `GET`.
3. **`curl --max-time 400`** in the `crawler` service's start command. When that
   fires the client gives up, the response is lost, and whatever the server was
   mid-way through is neither reported nor cleanly abandoned. This is the hard
   wall, and at the assumed 120s/company it sits at 3.3 companies — which is
   almost certainly where the constant 3 really came from.

**The bookkeeping is better than the scheduling, which is what makes a fix
cheap.** `crawlCompany` advances `last_checked_at` on **every** outcome, success
and failure alike, and increments `consecutive_failures` only on failure
(`lib/crawler.ts:736-745`). A company that breaks therefore leaves the due set for
another interval instead of being retried forever. That single property means a
"drain until empty" loop provably terminates, and it means **no queue table is
needed** — `watchlist` due-ness already *is* the queue, and it is already
idempotent under interruption.

Two gaps in that bookkeeping, both pre-existing and neither blocking:

- `consecutive_failures` is written but never read. `DUE_COMPANIES_SQL` does not
  back off a company that has failed twenty times; it re-crawls it every interval
  forever. At 3 crawls a night that is invisible. At 75 it is a tenant's whole
  quota burning on a dead careers page.
- If the post-crawl `watchlist` update fails, `last_checked_at` does not advance
  and the company stays due. The code notices and downgrades the run to `error`
  with an explicit message, so this is handled — but under a drain-until-empty
  loop it is the one path that could spin. The loop needs its own iteration cap
  for that reason, not for the failure case the code already covers.

## 3. Approaches

### A. One company per request, drained by a looping worker — *recommended*

A new route, `GET /api/cron/crawl-next`, does exactly one thing: pick the single
most-overdue company that some tenant still has quota for, crawl it, return
`{ crawled: true, company, tenantsRemaining, companiesRemaining }` — or
`{ crawled: false }` when there is no eligible work. The `crawler` service's
command becomes a loop that calls it until it returns `crawled: false`, then
exits (as a cron service) or sleeps until the next window (as a long-running one).

Per-tenant quota is enforced by counting what the tenant has already had tonight,
which is derivable from existing columns — `count(*) from watchlist where
tenant_id = $1 and last_checked_at >= <window start>` — so the quota needs no new
state and survives a worker restart, because it is recomputed from committed rows
rather than held in memory.

**Why this is the right shape.** The unit of work and the unit of failure become
the same thing: one company. `--max-time` stops being a batch guard sized against
a guess and becomes a per-company guard sized against a measured 91s tail (set it
to 300s and it is a genuine anomaly detector rather than a routine ceiling). A
timeout, a crash, or a redeploy loses at most one company, and the next iteration
picks up exactly where the last committed row left off. There is no partial-batch
state to reason about because there are no batches.

**Capacity, from the measured numbers.** 25 tenants × quota 3 = 75 crawls a
night. At the blended median that is about 7 minutes. In the pathological case
where every tracked company is search tier and every one hits the observed
maximum, it is 75 × 91.2s ≈ **114 minutes** — comfortably inside an overnight
window on a single worker, with roughly 2× headroom against a 4-hour window.
**One worker covers the 10–25 tenant target at quota 3 without concurrency.**

Concurrency is available if that headroom is ever wrong, but it is not free and
should not be built now: two workers can select the same most-overdue row, so it
needs an atomic claim. The cheap version — advance `last_checked_at` at claim
time rather than at completion — silently converts a worker crash into "this
company was crawled" and loses it for a full interval. The honest version is a
`crawl_claimed_at` column and `FOR UPDATE SKIP LOCKED`, which is a migration and
a stale-claim reaper. **Defer both. Build one worker; add a claim column only if
measured throughput demands a second.**

**Costs, stated plainly.** The `crawler` service stops being "run once, exit" and
becomes a drain loop, so its logs go from one line a night to one line per
company — which is an improvement for diagnosis and a change for anyone reading
those logs. `splitCrawlBatch` and its rotation become dead code: with per-tenant
quotas nobody is competing for a shared pool, so there is no starvation left to
rotate away, and `lib/crawl-fairness.ts` plus its tests should be deleted rather
than left to imply a fairness mechanism that no longer runs. `getDueCompanies`
gains a sibling that selects across tenants, which means one more place that
resolves a tenant — see §5.

### B. One request per tenant, shell loop over tenants

`/api/cron/crawl?tenant=<id>` handles one tenant's whole quota; the crawler
container loops over a tenant list fetched from a new `/api/cron/tenants`.

Simpler than A and a smaller diff. It fails on its own terms, though: the worst
case per request is quota × tail, so at quota 3 it is ~274s against a 400s
`--max-time` — it *fits*, barely, and stops fitting the moment any tenant sets
quota to 5, which is a thing Tom has asked to be possible. A design that breaks
when a user uses a feature as intended is not a design. It also re-introduces a
tenant-enumeration endpoint, which is the exact surface commit `3b0227c` just
closed on `listCrawlableTenants`; behind `CRON_SECRET` that is defensible, but it
is a step back on the day it was taken forward.

### C. Raise the constant and parallelize within one request

Rejected. It keeps the request as the unit of failure while making that unit
larger, so a timeout now loses more work than it does today. Parallel crawls
within a tenant would also multiply the instantaneous spend rate against a budget
ceiling that `withBudget` checks once at entry, turning a cap into an
approximation.

## 4. Where the quota lives — a real fork, and the cheap option is not the obvious one

`users.crawl_quota` **already exists**, unused, written by nothing. Migration 009
(applied 2026-08-17) deliberately left it out of `app_rw`'s column grants, with
the comment: *"nothing writes it today, and a future writer should fail loudly
rather than inherit access."* That future writer is this feature, and it will
indeed fail loudly. Using that column therefore requires
`grant update (crawl_quota) on users to app_rw;` as migration 010 — the first
concrete instance of the maintenance cost 009 predicted, which is a point in the
design's favour: the mechanism worked exactly as documented.

The alternative is an `app_settings` row, which is the established pattern for
anything a user edits (*"key/value jsonb, so a new setting needs no migration"*)
and is already per-tenant and already read by `loadCriteria()`.

**They differ in who can raise the number, which is the actual question.** A
quota in `app_settings` is tenant-settable from `/settings` with no migration and
no grant change. A quota in `users.crawl_quota` is unwritable by the application
at all, so only a database owner — or an admin action given an explicit new
column grant — can change it.

**Recommendation: both, with different jobs.** Tenant-settable quota in
`app_settings`, bounded in code the way `crawlIntervalError` bounds the interval
(1 to some `MAX_TENANT_QUOTA`), defaulting to 3. `users.crawl_quota` stays
unwritten and becomes an optional per-tenant **ceiling** the admin can set out of
band if one tenant ever monopolises the drain window; when it is null, the code
ceiling applies. That keeps the common case migration-free and keeps the override
in a place the app cannot write, which is where 009 deliberately put it.

The bound matters more than it looks. Spend is the tenant's own, but wall-clock
is shared: one tenant setting quota to 200 does not cost anyone money and does
delay everyone else's crawls until the drain reaches them. **The drain must
therefore iterate tenants round-robin rather than draining one tenant to
exhaustion before starting the next** — that is where `splitCrawlBatch`'s fairness
idea survives, as an ordering rule inside the selection query rather than as a
pre-computed split.

## 5. What this must not break

- **The new selection query is a second tenant-resolution path.** Today
  `getDueCompanies` runs inside `runAsTenant(...)` and resolves its tenant from
  the ambient platform scope. A cross-tenant "pick the next due company anywhere"
  query cannot, by construction, run inside a single tenant's scope. It must run
  in `runAsPlatform` with `tenantId: null`, select only `(tenant_id, company)`,
  and then enter `runAsTenant` for the crawl itself — so the *crawl* stays
  tenant-scoped under RLS and only the *selection* is platform-wide. Anything
  broader is a cross-tenant read wearing a scheduler's clothes. Grep
  `set_config('app.tenant_id'` and confirm the count of call sites does not grow.
- **`app/actions/auth-required.test.ts` must keep passing.** If any part of this
  lands as an exported server action, it needs a session check or a documented
  place on the `CRON_CALLED` list — and per the removal of the shared-password
  gate on 2026-08-17, there is no middleware backstop behind that test any more.
- **`withBudget` stays per tenant, per crawl.** A capped tenant is skipped, not
  failed, and skipping must not consume a drain iteration in a way that spins.
- **`repairJobLinks` is per tenant and currently runs once per tenant per night.**
  It costs no Claude tokens but does issue HTTP requests per open role. Under a
  drain loop it must not run once per *company*; it belongs at end-of-window, once
  per tenant, after that tenant's drain completes.

## 6. Recommendation

Approach A, one worker, quota in `app_settings` defaulting to 3, `users.crawl_quota`
as an admin-only ceiling left unwritten for now. No queue table, no claim column,
no second worker until measurement says otherwise — and measurement is now
possible, because `crawl_runs` answers the throughput question directly and
should be re-queried once there is more than one tenant in it.

**Before implementing, two things are worth doing first and neither is this
design:** read `consecutive_failures` in `DUE_COMPANIES_SQL` so a dead careers
page stops consuming quota, and re-run the §1 timing query once the sample
includes a high-yield crawl. The second may move the tail number this design is
sized against.

## Open questions for Tom

1. **Drain window.** Should the worker be a cron service that starts nightly and
   exits when drained, or a long-running service that drains and sleeps? Cron is
   simpler and matches today; long-running lets the interval mean something
   finer-grained than "once a night" later.
2. **`MAX_TENANT_QUOTA`.** What is the largest number a tenant may set for
   themselves before it needs an admin? The arithmetic, in the all-search-tier
   worst case on one worker at 25 tenants: quota 3 needs 114 minutes, quota 6
   needs 3.8 hours, quota 9 needs 5.7 hours. So the answer depends on how long
   the drain window is, and 9 only fits an overnight one. At the blended median
   all three are under 25 minutes — this bound protects against the worst tenant
   profile, not the typical one.
3. **Does the interval stay advisory?** With per-tenant quotas, a tenant tracking
   30 companies at a 7-day interval needs ~4.3 crawls a night to honour it and
   will not get it at quota 3. Either the UI says the interval is a floor and not
   a promise, or `/watchlist` computes the achievable interval from the quota and
   shows that instead. The current "next check" display promises the interval.
