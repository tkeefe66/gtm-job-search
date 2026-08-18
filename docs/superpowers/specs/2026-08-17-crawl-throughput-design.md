# Crawl throughput for 10–25 tenants

**Status:** design only. Nothing here is implemented. Revised 2026-08-17 after
Tom answered the three open questions in revision 1; the recommendation changed
shape as a result, and the reason is in §4.

**Target, set by Tom:** 10–25 tenants within 6–12 months; each tenant gets a
guaranteed crawl quota, defaulting to 3 and settable per tenant; no constraint on
infrastructure beyond stating what it costs to run.

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
average is therefore sizing it for a tenant who does not exist. **Every capacity
number in this document uses the 91.2s worst case, not the median**, precisely
because a single tenant can be entirely worst case.

**Now the caveats, because n=12 is not a measurement so much as a hint.**

- Twelve runs over five days, of which only **4 are search tier** and only **3
  found any roles at all** (`status = ok`). The p95 is computed over a sample too
  small to have a meaningful 95th percentile; read the `max` column and ignore
  the p95.
- Seven of twelve runs were `status = empty`, and an empty run **skips the
  expensive part** — URL liveness verification and fit-scoring run per role
  found, so a company returning 20 new roles does work no measured run did. The
  slowest observed run (91.2s) did find roles, so the tier cost is real, but
  nothing here bounds a high-yield crawl. **Assume the true tail is above 91s.**
  Every number below inherits that caveat.
- Every one of these runs happened with one tenant and three tracked companies.
  Nothing here has been observed under contention.

## 2. What actually constrains the design

Not Claude spend. Every non-admin tenant supplies their own API key
(`tenant_api_keys`), and the crawl is already metered through `withBudget`, which
skips a capped tenant rather than failing it. Adding throughput spends the
tenant's own money against their own budget ceiling. **Wall-clock and failure
granularity are the constraints, not cost.**

The real ceiling today is a chain of three:

1. **`DEFAULT_BATCH_LIMIT = 3`** — platform-wide, not per tenant.
   `splitCrawlBatch` divides those 3 slots round-robin across all active tenants,
   rotated by day number so the tenant who misses out changes nightly.
2. **One HTTP request holds the entire nightly run.** The route loops tenants,
   and within each tenant loops companies, sequentially, in a single `GET`.
3. **`curl --max-time 400`** in the `crawler` service's start command. At the
   assumed 120s/company that wall sits at 3.3 companies — which is almost
   certainly where the constant 3 really came from.

**The bookkeeping is better than the scheduling, which is what makes a fix
cheap.** `crawlCompany` advances `last_checked_at` on **every** outcome, success
and failure alike, and increments `consecutive_failures` only on failure
(`lib/crawler.ts:736-745`). Two consequences, and both matter more than they look:

- **A batch is not transactional.** Each company commits its own row as it
  finishes, so a `--max-time` timeout mid-batch loses the *report* and the
  *uncrawled remainder* — and the remainder simply stays due. Committed work
  stands. This is what makes §4's Phase 0 low-risk rather than reckless.
- **A drain-until-empty loop provably terminates,** because a company that breaks
  leaves the due set for another interval instead of being retried forever. **No
  queue table is needed** — `watchlist` due-ness already *is* the queue, and it is
  already idempotent under interruption.

Two gaps in that bookkeeping, both pre-existing:

- `consecutive_failures` is written but never read. `DUE_COMPANIES_SQL` does not
  back off a company that has failed twenty times. At 3 crawls a night that is
  invisible. At 75 it is a tenant's whole quota burning on a dead careers page.
- If the post-crawl `watchlist` update fails, `last_checked_at` does not advance
  and the company stays due. The code notices and downgrades the run to `error`
  with an explicit message, so this is handled — but under a drain-until-empty
  loop it is the one path that could spin. The loop needs its own iteration cap
  for that reason, not for the failure case the code already covers.

## 3. Decisions taken

Revision 1 ended with three open questions. Tom's answers, and what each settled:

| Question | Answer | Consequence |
|---|---|---|
| Cron-and-exit, or long-running worker? | **Long-running** | The drain window becomes the whole day, not a night. Capacity roughly triples, and `MAX_TENANT_QUOTA` stops being a hard trade-off (§4, Phase 1). |
| `MAX_TENANT_QUOTA`? | **10** | 25 tenants × 10 = 250 crawls/day worst case = 6.3 hours of a 24-hour drain. Comfortable, so the bound protects against one tenant monopolising the pipe rather than against running out of night. |
| Interval advisory, or keep the promise? | **Neither — warn instead** | A banner on the watchlist page when the configured interval is not achievable. Better than relabelling the interval everywhere: it keeps the interval meaning what users expect and only speaks up when it cannot be met. |

**Choosing long-running has one consequence that was not in revision 1:** "nightly
quota" stops meaning anything, because there is no night. It becomes a **daily**
quota and needs a defined reset. Recommend a **fixed boundary (UTC midnight)**
over a rolling 24-hour window: rolling is smoother, fixed is easier to explain to
a user and much easier to test, and the smoothness buys nothing at these volumes.

## 4. The plan is staged, and Phase 1 should not be built yet

Revision 1 recommended building the worker. That was sized against the 10–25
tenant target and ignored the present, which is the wrong way round.

**Production today: 1 tenant, 3 tracked companies, all at `crawl_interval_days =
14`.** That is a demand of **0.21 crawls/day** against a capacity of 3/night —
over-provisioned by roughly 14×. The interval that "slips immediately" is not
currently set to 7 by anyone.

The constraint is one formula, and it is worth writing down because it says *when*
to care rather than *whether*:

```
tenants × companies_tracked ÷ interval_days   ≤   crawls per day
```

At today's capacity of 3/day, that holds until roughly **10 tenants tracking 5
companies each on a 7-day interval** (7.1/day needed — the next tenant breaks it).
Two or five tenants is not a problem. The worker is the answer to a question the
platform has not yet been asked.

### Phase 0 — now. Two constants, one query, one banner. No new service.

**Raise `DEFAULT_BATCH_LIMIT` to 8 and `--max-time` to 900 together.** At the
measured 91.2s worst case, 8 companies is ~12.2 minutes. This is a **2.7×
capacity increase from two constants**, and by the formula above it carries the
platform to ~10 tenants at 5 companies on a 7-day interval.

It is low-risk for the reason in §2: the batch is not transactional, so a timeout
costs the uncrawled remainder and nothing already committed. **One thing to verify
before shipping it — whether Railway's HTTP edge imposes a request timeout shorter
than 900s.** That number is not known and must not be guessed; if the edge caps
lower, the limit comes down to fit it and Phase 1 arrives sooner.

Neither constant may be raised without re-reading `crawl_runs`. Both carry the
n=12 caveat, and 8 is chosen against a tail that §1 says is probably optimistic.

**Read `consecutive_failures` in `DUE_COMPANIES_SQL`.** Independent of everything
else and worth doing on its own: it stops a dead careers page from consuming a
slot every cycle. This gets *more* valuable as capacity rises, not less.

**Build the capacity banner.** Its user-facing job is the answer to question 3;
its real job in Phase 0 is **instrumentation**. It turns "are we out of road?"
from a guess into a number on a page that is already looked at, and it is the
signal that starts Phase 1. The arithmetic needs no new data:

```
achievable_days = companies_tracked ÷ crawls_per_day_for_this_tenant
```

Compare to the configured `crawl_interval_days`; warn when achievable > configured.

**The banner has two lifetimes, and this is the wrinkle to know before writing the
copy.** Per-tenant quota does not exist in Phase 0 and cannot — quota plus a
single-HTTP-request crawl makes the worst case `tenants × quota × 91s`, which is
exactly the blowup `splitCrawlBatch` exists to prevent. So in Phase 0 the remedy
sentence is *"track fewer companies, or lengthen the interval"*; in Phase 1 it
becomes *"set quota to 5 in Settings."* Same arithmetic, different remedy.

**Name the number, never just the direction.** "You track 30 companies at a 7-day
interval. At the current rate that is a full pass every 10 days." A bare "increase
your quota" asks the user to do arithmetic from inputs they do not have.

**The per-row "next check" display is the thing actually lying, and a banner does
not fix it.** A row promising "next check in 7 days" is wrong whether or not there
is a warning above it. Either compute that column from the achievable rate, or
relabel it "earliest next check."

### Phase 1 — when the banner says the platform is short. Not before.

A new route, `GET /api/cron/crawl-next`, does exactly one thing: pick the single
most-overdue company that some tenant still has quota for, crawl it, return
`{ crawled: true, company, companiesRemaining }` — or `{ crawled: false }` when
there is no eligible work. The `crawler` service becomes **long-running**: drain
until `crawled: false`, sleep, repeat.

Quota is enforced by counting what the tenant has already had today —
`count(*) from watchlist where tenant_id = $1 and last_checked_at >= <UTC
midnight>` — so it needs no new state and survives a worker restart, because it is
recomputed from committed rows rather than held in memory.

**Why this shape.** The unit of work and the unit of failure become the same
thing: one company. `--max-time` stops being a batch guard sized against a guess
and becomes a per-company anomaly detector (300s against a 91s tail). A timeout,
a crash, or a redeploy loses at most one company.

**Capacity.** One worker at the 91.2s worst case does ~40 crawls/hour, so a
24-hour drain is **~960 crawls/day**. 25 tenants × quota 10 = 250/day, or 6.3
hours of drain — roughly 4× headroom. **One worker covers the target with no
concurrency.**

**Costs.** The `crawler` service's logs go from one line a night to one line per
company. `splitCrawlBatch` and `lib/crawl-fairness.ts` become dead code — with
per-tenant quotas there is no shared pool to rotate — and should be **deleted**
rather than left implying a fairness mechanism that no longer runs. The selection
query must still iterate tenants round-robin rather than draining one tenant to
exhaustion, which is where that fairness idea survives: as an ordering rule inside
the query rather than a pre-computed split.

### Phase 2 — probably never

Queue table, `crawl_claimed_at`, `FOR UPDATE SKIP LOCKED`, multiple workers. Only
if one worker saturates, which at ~960 crawls/day it will not at 25 tenants.

Worth stating why the cheap version of concurrency is not on the table even then:
advancing `last_checked_at` at claim time instead of at completion silently turns
a worker crash into "this company was crawled" and loses it for a full interval.
If concurrency is ever needed, it needs a real claim column and a stale-claim
reaper, not a reordering.

## 5. Approaches considered and rejected

**One request per tenant, shell loop over tenants.** `/api/cron/crawl?tenant=<id>`
plus a new `/api/cron/tenants`. Simpler than Phase 1 and a smaller diff, but the
worst case per request is `quota × tail`, so at quota 3 it is ~274s against a 400s
`--max-time` — it *fits*, barely, and stops fitting the moment any tenant sets
quota to 5, which Tom has asked to be possible. A design that breaks when a user
uses a feature as intended is not a design. It also re-introduces a
tenant-enumeration endpoint, which is the exact surface commit `3b0227c` just
closed on `listCrawlableTenants`; behind `CRON_SECRET` that is defensible, but it
is a step back on the day it was taken forward.

**Raise the constant and parallelize within one request.** Rejected as a *Phase 1*
answer — note this is not the same as Phase 0, which raises the constant and keeps
the loop sequential. Parallel crawls within a tenant multiply the instantaneous
spend rate against a budget ceiling that `withBudget` checks once at entry,
turning a cap into an approximation.

## 6. Where the quota lives (Phase 1)

`users.crawl_quota` **already exists**, unused, written by nothing. Migration 009
(applied 2026-08-17) deliberately left it out of `app_rw`'s column grants, with
the comment: *"nothing writes it today, and a future writer should fail loudly
rather than inherit access."* Using that column therefore requires
`grant update (crawl_quota) on users to app_rw;` as a further migration — the
first concrete instance of the maintenance cost 009 predicted, which is a point in
its favour: the mechanism worked exactly as documented.

The alternative is an `app_settings` row, the established pattern for anything a
user edits (*"key/value jsonb, so a new setting needs no migration"*), already
per-tenant and already read by `loadCriteria()`.

**They differ in who can raise the number, which is the actual question.**
`app_settings` is tenant-settable from `/settings` with no migration and no grant
change. `users.crawl_quota` is unwritable by the application at all, so only a
database owner can change it.

**Recommendation: both, with different jobs.** Tenant-settable quota in
`app_settings`, bounded in code the way `crawlIntervalError` bounds the interval
(1 to `MAX_TENANT_QUOTA` = 10), defaulting to 3. `users.crawl_quota` stays
unwritten and becomes an optional per-tenant **ceiling** an admin can set out of
band if one tenant ever monopolises the drain; when null, the code ceiling
applies. The common case stays migration-free and the override stays where 009
deliberately put it.

## 7. What this must not break

- **Phase 1's selection query is a second tenant-resolution path.** Today
  `getDueCompanies` runs inside `runAsTenant(...)` and resolves its tenant from
  the ambient platform scope. A cross-tenant "pick the next due company anywhere"
  query cannot, by construction, run inside a single tenant's scope. It must run
  in `runAsPlatform` with `tenantId: null`, select only `(tenant_id, company)`,
  and then enter `runAsTenant` for the crawl itself — so the *crawl* stays
  tenant-scoped under RLS and only the *selection* is platform-wide. Anything
  broader is a cross-tenant read wearing a scheduler's clothes. Grep
  `set_config('app.tenant_id'` and confirm the count of call sites does not grow.
- **`app/actions/auth-required.test.ts` must keep passing.** If any part of this
  lands as an exported server action it needs a session check, or a documented
  place on the `CRON_CALLED` list — and since the shared-password gate was removed
  on 2026-08-17 there is no middleware backstop behind that test any more.
- **`withBudget` stays per tenant, per crawl.** A capped tenant is skipped, not
  failed, and skipping must not consume a drain iteration in a way that spins.
- **`repairJobLinks` is per tenant and currently runs once per tenant per run.**
  It costs no Claude tokens but issues HTTP requests per open role. Under a drain
  loop it must not run once per *company*; it belongs at end-of-drain, once per
  tenant.

## 8. Open questions

1. **Does Railway's HTTP edge cap request duration below 900s?** Phase 0's batch
   limit of 8 depends on it. Needs checking, not guessing.
2. **Phase 0 banner copy** — the exact sentence, given the remedy changes between
   phases (§4).
3. **Re-run §1's timing query once the sample includes a high-yield crawl.** Every
   capacity number here is sized against a 91.2s tail drawn from 3 runs that found
   roles. If the real tail is 200s, Phase 0's limit of 8 becomes 4 and Phase 1
   arrives roughly twice as soon.
