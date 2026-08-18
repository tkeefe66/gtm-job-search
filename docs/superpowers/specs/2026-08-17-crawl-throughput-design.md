# Crawl throughput for 10–25 tenants

**Status:** design only. Nothing here is implemented. Revision 3, 2026-08-17, after
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
3. **Railway's edge closes a silent request after 300s** — not `curl --max-time
   400`, which is what the `crawler` service's start command sets and what
   revision 2 of this document assumed was the wall. Railway's published limits
   are: *"HTTP requests can run for up to 15 minutes if data keeps transferring
   (for example, keep-alive heartbeats), and are otherwise closed after 5 minutes
   with no data transferred."*

   The route sends nothing until the entire batch is done and it returns
   `NextResponse.json(...)`, so it is a silent request and gets **300 seconds**.
   `--max-time 400` is therefore dead configuration: the edge cuts the connection
   a hundred seconds before curl's own timeout could fire.

   **At the measured 91.2s tail, 300s is 3.29 companies — and `DEFAULT_BATCH_LIMIT`
   is 3.** The constant is accidentally right. It was chosen against a 120s guess
   and a 400s wall, and it happens to land just under a 91.2s tail and a 300s
   wall. There is essentially **no headroom** at the current limit, and the
   per-tenant `repairJobLinks` pass runs inside the same request, eating into it.

   Verified 2026-08-17 that no CDN is in front of this: `jobs.tomkeefe.ai` answers
   with `server: railway-hikari` and `x-railway-edge: den1`, and `WEB_URL` — what
   the crawler actually calls — is the `.up.railway.app` domain, so Cloudflare's
   100s origin timeout is not in the path. Railway's edge is the only wall.

**The bookkeeping is better than the scheduling, which is what makes a fix
cheap.** `crawlCompany` advances `last_checked_at` on **every** outcome, success
and failure alike, and increments `consecutive_failures` only on failure
(`lib/crawler.ts:736-745`). Two consequences, and both matter more than they look:

- **A batch is not transactional.** Each company commits its own row as it
  finishes, so a `--max-time` timeout mid-batch loses the *report* and the
  *uncrawled remainder* — and the remainder simply stays due. Committed work
  stands. This is what lets the drain loop in §4 be interrupted at any point —
  by a timeout, a redeploy, or a crash — without losing or double-crawling
  anything.
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

### Phase 0 — now. One route, one loop, one query, one banner. No new service.

**Revision 2 of this document proposed raising `DEFAULT_BATCH_LIMIT` to 8 and
`--max-time` to 900. That does not work, and §2's edge limit is why.** Eight
companies is ~730 seconds of silence, and Railway closes a silent request at 300.
The 900s ceiling exists only for requests that keep transferring data, which this
one does not. Raising the constants alone would produce a run that is killed
mid-batch every night, reported as a curl failure, while the server kept working
and committing rows — the most confusing possible failure.

Three ways out. **Take the third.**

- *Keep the batch, raise the constant.* Impossible past 3. There is no headroom
  under 300s, so this is not an option at all.
- *Keep the batch, stream the response* so the request stays alive to the 15-minute
  limit — emit a progress line per company as it completes. This works and unlocks
  ~9 companies, but it is a real change to the route (a `ReadableStream` instead of
  `NextResponse.json`) in service of a batch shape that Phase 1 deletes anyway.
- ***Shrink the request to one company.*** Build `GET /api/cron/crawl-next` — the
  Phase 1 route — now, and have the existing cron container call it in a bounded
  shell loop. Each request is ~91s worst case against a 300s silent limit, so it
  fits with 3× margin and needs no streaming. Capacity stops being bounded by the
  edge at all and becomes bounded by how long the loop runs.

**Phase 0 and Phase 1 therefore converge, and Phase 1 shrinks to a deployment
change.** The route, the selection query and the drain loop all land in Phase 0;
Phase 1 becomes "flip the crawler service from cron to long-running, and add
per-tenant quota." That is a better split than revision 2's, and it came out of
the edge limit rather than a preference.

`--max-time` drops to **300** to match the edge rather than exceed it, where it
becomes a per-company anomaly detector against a 91.2s tail instead of dead
configuration.

**The `crawler` service's start command becomes the loop.** Not applied yet — the
route has to be deployed first, or every iteration 404s:

```sh
sh -c 'for i in $(seq 1 30); do
  r=$(curl -sS --max-time 300 -H "Authorization: Bearer $CRON_SECRET" "$WEB_URL/api/cron/crawl-next");
  echo "$r";
  echo "$r" | grep -q "\"crawled\":true" || break;
done'
```

The bound of 30 is the iteration cap §2 asks for. It is not the capacity limit —
the loop normally ends on `crawled:false` — it is the backstop for the one path
that could spin: a post-crawl `watchlist` update that fails leaves
`last_checked_at` un-advanced, so the same company stays due and would be picked
again. Thirty iterations at the 91.2s tail is ~45 minutes, and a curl that errors
produces empty output, fails the grep, and breaks the loop rather than hammering.

**Stop tracking a careers page that stays dead for a week**
(`lib/dead-tracking.ts`, `db/migrations/010_watchlist_failing_since.sql`).
Independent of everything else and worth doing on its own: a dead page was
crawled on schedule forever, because nothing ever gave up.

This REPLACED an exponential backoff that earlier revisions proposed, and the
reason is worth keeping. Backing off retries a suspect page less and less often,
which sounds like the same goal — but it delays the very evidence that proves the
page is dead, so a "gone for a week" rule would fire a fortnight late or worse.
Retry on the normal schedule, then stop entirely. Simpler, and it means what it
says.

Two details that are not obvious:

- **It needs a column.** `consecutive_failures` and `last_checked_at` both
  describe the LAST check, so between them they say how many failures there have
  been and when the most recent was, never when the FIRST one was. A company on a
  14-day interval with 2 failures could have been broken for 15 days or for 29,
  and the difference decides the call. `failing_since` is set on the first failure
  of a run and cleared by any success.
- **Two failures minimum, whatever the clock says.** At a 14-day interval a
  company that fails once is not retried until day 14, so at day 7 the only
  evidence is a single failure — as likely a timeout or a bot-block as a dead
  page. Dropping on that untracks a live company for one bad night.

"Stop tracking" is `tracking_enabled = false`, never a delete: the row holds the
careers URL the user may have fixed by hand and its whole crawl history, and the
soft-disable exists so that survives. A manual toggle clears `failing_since` in
both directions, which is what lets the Watchlist tell "we gave up" apart from
"you turned it off" — they need different sentences and different remedies.

`"empty"` is not a failure. A careers page that loads and lists nothing is
working, and the week only counts `error` and `needs_url`.

**Build the capacity banner.** Its user-facing job is the answer to question 3;
its real job in Phase 0 is **instrumentation**. It turns "are we out of road?"
from a guess into a number on a page that is already looked at, and it is the
signal that starts Phase 1.

It measures the SYMPTOM rather than modelling capacity. The modelled version —
tracked companies divided by this tenant's share of throughput — needs to know
how many tenants exist, which is a cross-tenant fact this page must not read, and
it predicts contention instead of observing it. So: count the tenant's companies
that are past a whole extra cycle, from their own `watchlist` rows.

The threshold is a MISSED FULL CYCLE, not "late at all" — a queue-driven crawler
is routinely a little late on something, and a banner that fires on that is
permanent, which makes it furniture. Companies whose last check FAILED are
excluded, because they are dead-tracking's problem and "track fewer companies"
would be wrong advice for them.

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

Most of what revision 2 put here moved into Phase 0, because the edge limit forced
the one-company route to be built immediately. What is left is genuinely two
things: **flip the `crawler` service from a cron run to long-running**, and **add
per-tenant quota**.

The route built in Phase 0, `GET /api/cron/crawl-next`, does exactly one thing:
pick the single most-overdue company that some tenant still has quota for, crawl
it, return `{ crawled: true, company, companiesRemaining }` — or
`{ crawled: false }` when there is no eligible work. In Phase 0 a cron container
loops it a bounded number of times and exits; in Phase 1 the service drains until
`crawled: false`, sleeps, repeats. The route does not change between them, which
is the point — Phase 1 is a deployment change plus a quota check, not a rewrite.

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
company.

`splitCrawlBatch` and `lib/crawl-fairness.ts` die in **Phase 0**, not here — the
moment selection picks one company across all tenants there is no batch left to
pre-split. They should be **deleted** rather than left implying a fairness
mechanism that no longer runs. The idea survives as an **ordering rule inside the
selection query**: iterate tenants round-robin rather than draining one tenant to
exhaustion. That rule matters in Phase 0 even without quota, and it is the part of
`lib/crawl-fairness.ts` worth reading before deleting it.

The old `GET /api/cron/crawl` route also becomes redundant in Phase 0. Keep it
until the loop has run a few nights, then delete it — leaving two routes that
crawl is how the batch limit comes back by accident.

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

1. ~~Does Railway's HTTP edge cap request duration below 900s?~~ **Answered
   2026-08-17: yes — 300s silent, 900s only while data transfers.** It is the
   single most consequential fact in this document; it killed revision 2's Phase 0
   and merged Phase 0 with Phase 1. See §2 and §4.
2. **Phase 0 banner copy** — the exact sentence, given the remedy changes between
   phases (§4).
3. **Re-run §1's timing query once the sample includes a high-yield crawl.** Every
   capacity number here is sized against a 91.2s tail drawn from 3 runs that found
   roles. A 200s tail would still fit one company inside the 300s silent limit,
   so Phase 0's shape survives it — but the margin drops from 3× to 1.5×, the
   per-hour drain rate halves, and Phase 1 arrives roughly twice as soon. If the
   tail ever approaches 300s, the route must stream and §4's second option comes
   back on the table.
