# Multi-tenant auth, tenancy and metering — design

> **SUPERSEDED — kept as the record, not as guidance.**
> Replaced by `2026-08-16-multi-tenant-auth-design.md`, which lists what this
> document got wrong. Nothing here should be implemented. Preserved on `main`
> on 2026-08-17 from commit `4462ce3` (branch `multi-tenant-auth`, since
> deleted), because revision 2 cites it and it existed nowhere else.

Date: 2026-08-15
Status: approved for planning
Branch: `multi-tenant-auth`

## Why

The app is live at `https://jobs.tomkeefe.ai` with **no authentication of any kind**.
Anyone who finds the URL can read the pipeline, rewrite the fit brain at `/settings`,
and click Discover or Find Roles — which spends Anthropic credits. The only guarded
surface in the app is `app/api/cron/crawl`, behind `CRON_SECRET`.

There are also **no backups**. The Railway project holds exactly three services —
`web`, `crawler`, `Postgres` — with no bucket and no dump job. One bad migration is
currently permanent.

The goal is to turn a single-user tool into a multi-tenant product where anyone can
sign in with Google, `tkeefe66@gmail.com` is the platform admin, and the cost of
other people's usage is bounded and visible.

## Decisions

Settled during the 2026-08-15 brainstorming session. These are inputs to the design,
not open questions.

| Decision | Choice |
|---|---|
| Tenant model | One user = one tenant. No orgs, no membership, no sharing. |
| Signup | Google OAuth only. Unknown emails land on a waitlist and cannot use the app until the admin approves them in-app. |
| Admin | `tkeefe66@gmail.com`, seeded. Can approve/deny, set budgets, impersonate, suspend and delete. |
| Impersonation | Full act-as, every action audited. |
| Cost model | Platform key with a per-tenant monthly ceiling of **$10**, admin tenant exempt, and **bring-your-own-key** to bypass the ceiling. |
| Data sharing | World data (funding results, role searches, crawl results, company metadata) is **global and shared**. Pipeline data (jobs, fit scores, settings, insights, watchlist subscriptions) is **tenant-isolated**. |
| Isolation enforcement | Postgres RLS with `FORCE`, **plus** tenant scoping enforced in the query builder. Both. |
| Crawl scheduling | One platform-wide interval, admin-set. Tenants cannot choose their own. |
| Crawl quota | 10 tracked companies per non-admin tenant, with caps stated plainly as free-tier limits wherever they bite. |
| Onboarding | AI interview — resume paste/upload plus a text-or-voice conversational intake — synthesized into criteria and a fit brain. |
| Backups | Nightly `pg_dump` to **Cloudflare R2**. |
| Secrets in git history | Rotate `ANTHROPIC_API_KEY` and `CRON_SECRET`; leave history alone; repo stays private. |

## Scope: six sub-projects

This is too large for one implementation plan. Each sub-project below gets its own
spec and plan. Dependencies are strict.

```
A. Backups + key rotation   (no deps)
        |
B. Auth gate                (needs A)
        |
C. Multi-tenancy            (needs B)   <-- the risky one
        |
   +----+----+----------------+
   |         |                |
D. Budgets   E. Admin console  F. AI onboarding interview
             (E is best after D, so budgets exist to administer)
```

**A → B closes the open-URL exposure within days.** C is the dangerous schema change
and runs behind a locked door with backups already working. D and E may land in
either order. F can be built in parallel with either once C is done.

---

## Cross-cutting architecture

Four concerns cut across sub-projects. Getting them wrong in one place breaks all six.

### Identity

`users` is the tenant. There is no separate tenant table, but the foreign key column
on every scoped table is named **`tenant_id`**, not `user_id`. Orgs are not being
built and may never be — but if they ever are, the change is a new membership table
and a resolver, not a rename touching ~36 call sites. The naming costs nothing today.

### Tenant scope resolution

One function resolves the acting tenant for a request, and it is the only place that
decides:

```
resolveActor(session) -> { userId, tenantId, isAdmin, impersonating: boolean }
```

Under impersonation, `userId` stays the admin and `tenantId` becomes the target. Every
audit row records both. Nothing else in the codebase reads the session directly.

### Key resolution

`lib/anthropic.ts` currently reads `process.env.ANTHROPIC_API_KEY` at module scope.
BYO key makes the key per-tenant, so it must be passed in — which touches every caller
in `app/actions/`, `lib/crawler.ts` and `lib/ingest-roles.ts`.

**Those are the same files C rewrites for tenant scoping, so key resolution lands in
C, not D.** "Which tenant is this for" and "which key does it bill" travel together
through identical call sites; splitting them means editing every one of them twice.

```
resolveApiKey(tenantId) -> { key, billedTo: "platform" | "tenant" }
```

D consumes this for metering and the ceiling. C only has to make it exist and thread
it through.

### Cost model

Three tiers:

| Tier | Key | Ceiling |
|---|---|---|
| Admin | platform | none |
| Free | platform | $10/month, 10 tracked companies |
| BYO | tenant's own | none; usage still recorded so the tenant can see it |

The pre-call budget check is skipped when `billedTo === "tenant"`. Metering is not.

---

## A. Backups + key rotation

**Deliverable:** a nightly dump of the app database to Cloudflare R2 that cannot
silently succeed against the wrong database, plus rotated credentials.

### The job

Runs on a Railway cron service. Not on `web` — `web` must never hold a credential
that can read every tenant's data or alter schema.

Before writing a single byte, the job asserts the app's own tables exist in the
source database:

```sql
SELECT current_database(),
       (SELECT count(*) FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name IN ('jobs','watchlist','app_settings','users'))
```

Zero app tables → refuse, exit non-zero, alert. **Check tables, not rows** — a
legitimately new install has an empty `jobs` table but a full schema, while the wrong
database has no app tables at all. A row-count or file-size threshold false-positives
on the former.

This guard exists because Railway's `${{Postgres.DATABASE_URL}}` reference points at
the platform's default database (`PGDATABASE=railway`), which is frequently *not* the
one the app created. `pg_dump` against it succeeds, uploads a valid few-kilobyte file
over the real backup's key, and reports green. **A green backup job is not evidence of
a backup.**

### Requirements

- Compose the connection from discrete `PGUSER`/`PGPASSWORD`/`PGHOST`/`PGPORT` vars
  with the database name pinned explicitly. Do not parse a URL — `urlparse` does not
  percent-decode, so a password containing `@` or `%` authenticates as the wrong
  string.
- Log `current_database()` on every run.
- **Date-stamped object keys** (`gtm-job-search/YYYY-MM-DD.sql.gz`), so a refused or
  corrupt run cannot overwrite a good backup.
- Retention: 30 daily, 12 monthly.
- Private R2 bucket. No public access, ever.
- A documented, *tested* restore path. An untested backup is a hypothesis.

### The constraint BYO key adds

Once tenants store their own Anthropic keys, **every nightly dump contains
credentials** — encrypted, but present.

That is acceptable only if the encryption key never enters Postgres. It lives in a
Railway environment variable read at runtime, so a stolen R2 object is ciphertext with
no key beside it. **If the encryption key is ever moved into a settings table for
convenience, one leaked backup becomes every tenant's Anthropic account.** This is a
permanent constraint on A and on C's schema.

### Key rotation

`.env.production` was committed at `165b2c0` (2026-07-14) and remains in history
pushed to `github.com/tkeefe66/gtm-job-search`. The repo is private, so this is
contained, but the values in it are live.

Rotate `ANTHROPIC_API_KEY` and `CRON_SECRET`, update both `web` and `crawler`. History
is left alone by decision; the consequence is that **the repo can never be made public
without a history rewrite**, and that fact belongs in CLAUDE.md.

---

## B. Auth gate

**Deliverable:** nothing in the app is reachable without an approved Google login.
Data is untouched — still one user, no tenant column yet.

### Stack

Auth.js (NextAuth) v5, Google provider, Postgres adapter, database sessions. Adds
`accounts`, `sessions`, `verification_tokens`.

### Session policy

Auth.js database sessions give a server-side row with an expiry, which satisfies most
of what a session needs. Two things it does **not** give, both of which must be added:

- **An absolute lifetime cap.** Auth.js rolls `expires` forward on use, so an actively
  used stolen cookie never dies. Add `created_at` to the session row and reject when
  `now - created_at > 30 days`, independently of the sliding renewal. Advance
  `expires`, never `created_at`.
- **Fail closed.** If the session store is unreachable, the request is a 500, never an
  authenticated request. `lib/supabase.ts` returns `{ error }` rather than throwing,
  and an empty error string is a real failure — use the presence check from
  `lib/write-failure.ts` (see the `swallowed-string-errors` project skill).

Also required: a real logout that **deletes the session row**, not one that clears a
cookie and leaves the token valid for anyone holding a copy. Sliding window 7 days
idle, absolute cap 30 days.

### Waitlist

Unknown email signs in with Google → a `users` row is created with
`status = 'pending'` and **no usable session is issued**. They see a waitlist screen.
The pending row is what the admin console lists.

`status`: `pending` | `active` | `suspended` | `denied`. Only `active` gets a session.
`tkeefe66@gmail.com` is seeded `active` with `role = 'admin'` by migration.

### Throttling

Google-only login removes the password-spray surface — there is no password to spray,
which is a real security benefit of the choice. The concurrency lesson it would have
taught still applies, but it lands on **the budget counter in D** instead, which has
exactly the same read-modify-write shape and the same ~40-way threadpool concurrency.

The endpoints that still need protection: the waitlist submission and the admin
approve/deny actions.

### Also in B

- Security headers: `X-Frame-Options: DENY`, `CSP: frame-ancestors 'none'`, `nosniff`,
  `Referrer-Policy`, HSTS. Without framing protection anyone can iframe the login and
  overlay a fake one. Note that middleware typically does not cover unhandled 500s.
- Confirm no state-changing `GET` endpoints. `SameSite=Lax` still sends cookies on
  top-level navigation, so a link can trigger any mutating GET.
- The cron route keeps its bearer secret and is exempt from the session gate.

---

## C. Multi-tenancy

The risky one. Schema migration, RLS, a new database role, and a rewrite of every
data access path.

### Table classification

**Tenant-scoped** (gain `tenant_id`, gain RLS `FORCE`):
`jobs`, `app_settings`, `watchlist`, `insights_cache`, plus the new `usage_*`,
`tenant_api_keys` and `audit_log`.

**Global** (world data, no `tenant_id`, readable by all authenticated tenants):
`discovered_startups`, `role_searches`, `discovered_roles`, `crawl_runs`, and the new
`companies` and `company_careers_urls`.

`insights_cache` is tenant-scoped despite being a cache: insights describe *your*
pipeline, not the world.

### Uniqueness constraints that break

Every unique in the current schema is global and must become composite or move:

| Today | Becomes |
|---|---|
| `app_settings.key` **primary key** | `primary key (tenant_id, key)` |
| `watchlist.company` unique | `unique (tenant_id, company_id)` |
| `discovered_roles.company` unique | unchanged — global |
| `discovered_startups (date_range, search_term)` | unchanged — global |
| `role_searches (family, search_term)` | unchanged — global |

`app_settings` is the sharpest edge: the fit brain, target titles, comp floor and
search ceiling are all in there as one global row set today.

### `watchlist` splits

A watchlist row is currently three things fused: a *crawl target*, a *set of careers
URLs with their crawl state*, and a *subscription*. Under sharing they separate, so
that two tenants tracking Ramp cost one crawl. Two of the resulting tables are below;
the third, `company_careers_urls`, has its own section after this one.

**`companies`** — global, one row per company, crawled once:
`company`, `tagline`, `raised`, `stage`, `lead_investor`, `founded`, `traction`,
`category`, `headquarters`, `source`, `added_at`.

**`watchlist`** — tenant-scoped, a pure subscription:
`tenant_id`, `company_id`, `added_at`, `tracking_enabled`.

Note what is absent: `crawl_interval_days` is gone (platform-wide now, see below) and
all crawl state has moved to the URL table below.

Consequences:

- **`getDueCompanies` becomes "companies with at least one enabled subscriber, due per
  the platform interval"** and dedupes across tenants automatically.
- **The 10-company quota stops mapping to platform spend, in our favour.** Ten tenants
  each tracking the same ten companies is ten crawls, not a hundred. The quota bounds
  a tenant's *list*; real cost is the size of the union.
- **One crawl, N pipelines, N fit scores.** A shared crawl finds a role once, then fans
  it into each subscriber's `jobs` with that tenant's own fit score from their own fit
  brain. The cheap shared part is shared; the expensive per-tenant part (`scoreFit`)
  is still paid per tenant. Same split as the discovery caches, applied to crawling.

### `company_careers_urls` — a candidate list, not a column

Requirement: a careless user's edit must not degrade a careful user's crawl. With a
single global `careers_url` column, the last edit wins for everyone.

New global table, many rows per company:
`company_id`, `url`, `origin` (`discovered` | `user` | `admin`),
`added_by_tenant_id`, `rank`, `status` (`active` | `demoted` | `blocked`),
plus the crawl state that used to sit on `watchlist`: `crawl_method`, `last_tried_at`,
`last_crawl_status`, `last_crawl_error`, `consecutive_failures`, `roles_found_last`.

Moving crawl state here is a genuine tidy-up: `crawl_method` (HTML vs `web_search`
fallback) was always a property of a *URL*, not of a company. Today it must be reset
by hand whenever the URL changes; with per-URL rows that reset is structural and
cannot be forgotten.

Rules:

- **A user edit adds a candidate; it never overwrites one.** A bad URL cannot delete a
  good one — the worst it does is sit unused.
- **Primary is decided by evidence, not recency.** The URL that most recently returned
  roles ranks first. Who typed last is irrelevant.
- **The happy path costs one fetch.** The crawler tries the primary only, falling
  through to the next candidate solely when the primary fails definitively or returns
  zero roles — which is exactly when a second try is wanted anyway.
- **Admin can pin** (freeze primary against evidence) **or block** (never try again).
- **Cap of 5 active candidates per company**, so nobody can grow a company's crawl
  into fifty fetches.
- A failed *read* never demotes a candidate.

This supersedes `resolveCareersUrlWrite` in `lib/careers-url-precedence.ts`. That
function was built for this exact fear in the single-user world — "an existing
hand-typed URL always wins over a guess" — but it cannot distinguish two *users*,
since a hand edit still overwrites a hand edit. With nothing ever overwritten there is
nothing left to protect. Its "unknown is a state of its own, and failing soft to a
value that licenses an overwrite is not acceptable" reasoning carries forward as the
no-demote-on-failed-read rule.

### `platform_settings`

New table, `key text primary key, value jsonb, updated_at`. No tenant column. Holds
the platform-wide crawl interval (default 7), default monthly budget (default $10),
default crawl quota (default 10), and the onboarding allowance.

Deliberately a separate table rather than a `tenant_id IS NULL` row in `app_settings`:
NULL comparisons inside an RLS policy are a well-known way to write a policy that
quietly matches nothing, or everything. Platform config does not belong in a table
governed by tenant policies.

### Isolation: RLS *and* the builder

**Database layer.** `ENABLE` plus **`FORCE ROW LEVEL SECURITY`** on every tenant-scoped
table. Plain `ENABLE` does not apply policies to the table's owner — without `FORCE`,
RLS is decorative for exactly the role most likely to be compromised. Policies read
the tenant from a session GUC:

```sql
CREATE POLICY tenant_isolation ON jobs
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
```

**`SET LOCAL`, never `SET`.** The `pg` pool (`max: 5`) reuses connections across
requests. A plain `SET app.tenant_id` leaks the previous request's tenant into the
next one — and RLS then *permits* the cross-tenant read, so the failure is silent and
looks correct. It must be `SET LOCAL` inside a transaction. **This needs a test that
drives two tenants through the same pooled connection and asserts the second sees
nothing of the first.**

**Application layer.** `lib/supabase.ts` gains a tenant-table registry. Building a
query against a registered table without a tenant scope **throws** — it does not
silently read the whole table. A test pins the registry against the schema so a new
tenant table cannot be added without being classified.

Belt and braces: a forgotten filter returns nothing rather than someone else's data,
and an unclassified table fails loudly at development time.

### Database roles

`web` currently holds the `postgres` superuser URL. **With RLS in play that is
decorative** — a superuser bypasses every policy.

- **`app_rw`** — `LOGIN NOSUPERUSER NOBYPASSRLS`, `SELECT/INSERT/UPDATE/DELETE` grants,
  **no ownership**. Used by `web` and `crawler`.
- **Owner credential** — migrations and backups only, on services that never serve a
  request.

Note honestly what this buys: dropping superuser removes host- and cluster-level
powers (`COPY TO PROGRAM`, reading `pg_authid`, creating roles). It does **not**
contain schema-level damage, because Postgres DDL is ownership-based — any role that
can `ALTER TABLE` owns the table, and a table owner can `ALTER TABLE ... NO FORCE ROW
LEVEL SECURITY`. Choose it for the former; do not pretend it delivers the latter.

### Tenant API keys

Stored on a `tenant_api_keys` table: `tenant_id`, `ciphertext`, `nonce`, `last_four`,
`added_at`, `status`, `last_verified_at`.

- Encrypted at rest with a key held **only** in a Railway env var (see A).
- **Write-only from the UI.** Never returned to the client after save; display is
  `sk-ant-...` plus `last_four`. This applies to the admin too — impersonation shows
  the mask, never the key.
- **Never interpolated into an error string.** Prevent the credential-bearing string
  from being constructed; do not scrub it afterwards. Store failure reasons from a
  closed set (`ok` | `auth` | `rate_limited` | `unreachable` | `see_logs`) and log
  detail server-side only.
- Test: throw an exception whose message embeds a full key and assert no fragment
  survives into anything user-visible or stored.

### Data migration

All existing rows become tenant 1 (`tkeefe66@gmail.com`). `app_settings` rows become
that tenant's settings; new tenants get the shipped `DEFAULT_*` constants from
`lib/search-criteria.ts` until F replaces that with the interview. The world caches
keep their rows as-is and simply stop being tenant-specific — which they never
actually were.

---

## D. Budgets, quotas and cap UX

**Deliverable:** a non-admin tenant cannot spend more than their ceiling, knows why
when they hit it, and can lift it by supplying their own key.

### Metering

`usage_events` — one row per billable call: `tenant_id`, `occurred_at`, `kind`,
`action`, `searches`, `input_tokens`, `output_tokens`, `cost_cents`,
`billed_to` (`platform` | `tenant`).

`usage_counters` — `(tenant_id, period)` with `spent_cents`, the hot path for the
pre-call check.

### The concurrency trap

The obvious implementation is wrong, and it is wrong in a way tests rarely catch:

```ts
const spent = await readSpent(tenantId);        // WRONG
if (spent + estimate > ceiling) return refuse;
await writeSpent(tenantId, spent + estimate);
```

Server actions run concurrently on a threadpool. N simultaneous requests all read the
same value and all write the same value — the counter advances by one estimate per
burst, not per request. The ceiling is roughly as weak as the concurrency is wide.

**Reserve atomically, then reconcile:**

```sql
INSERT INTO usage_counters (tenant_id, period, spent_cents)
VALUES ($1, $2, $3)
ON CONFLICT (tenant_id, period)
DO UPDATE SET spent_cents = usage_counters.spent_cents + $3
RETURNING spent_cents;
```

Refuse if the **returned** total exceeds the ceiling, releasing the reservation. After
the call completes, reconcile the reservation against actual cost. Estimates come from
`estimateRunCost` in `lib/cost-estimate.ts`, which already prices a run.

**Prove it with parallel requests.** A sequential test passes against the broken
version.

### Ceilings

- Monthly budget: platform default $10, per-tenant override set at approval.
- Crawl quota: platform default 10 tracked companies, per-tenant override.
- Admin tenant: exempt from both.
- BYO tenants: the **pre-call check is skipped**; metering still records, so the
  tenant can see their own spend.

### Cap UX — explicitly required

Every cap states plainly that it is a free-tier limit, in the place where it bites,
and offers the way out. Not a generic error.

- Budget consumed → search buttons disable with *"You've used your $10 of free Claude
  usage this month. Add your own Anthropic API key to keep going, or wait until
  [date]."*
- Quota reached → the Watch action disables with *"Free accounts can track 10
  companies. Untrack one, or add your own key."*
- A live budget meter on `/settings`, showing spend against ceiling and the reset date.
- BYO tenants see *"Billed to your Anthropic key"* wherever a free tenant sees the
  meter.

### BYO key failure handling

A tenant's key that is revoked, exhausted or rate-limited must surface as **their key
failing**, named as such — never as a generic search error, and **never by silently
falling back to the platform key**. Validate the key with a cheap test call on save
before storing it.

### Crawler quota

Per-tenant round-robin over due companies so one heavy tenant cannot starve the batch,
within the existing `DEFAULT_BATCH_LIMIT` per run. Because `companies` is global and
deduped, the union is what is actually crawled.

---

## E. Admin console

**Deliverable:** `/admin`, admin-only, four capabilities.

1. **Waitlist** — list pending signups, approve or deny, set that tenant's budget and
   crawl quota at approval time.
2. **Usage and budgets** — per-tenant spend and search counts against ceiling, with
   inline editing of budget and quota. No database surgery required to change a limit.
3. **Impersonation** — full act-as, plus an audit log viewer. An audit log nobody can
   read is not a control.
4. **Suspend / delete** — revoke access, purge data on request.

### Impersonation rules

- Every impersonated request writes an `audit_log` row: actor, target tenant, action,
  target row, timestamp, IP.
- A persistent, unmissable banner naming the impersonated tenant.
- Entering and leaving impersonation are themselves audited.
- **Search actions are blocked while impersonating a BYO tenant**, because clicking
  Find Roles inside their session bills *their* Anthropic account. An explicit,
  audited override exists for when the tenant has asked for help with exactly that.
- The banner names whose key is being billed.
- The admin cannot read a stored tenant key. Write-only applies to the admin too.

### Guarding the surface

`/admin` and every admin action check `role === 'admin'` server-side. A UI that merely
hides the nav link is not a control.

---

## F. AI onboarding interview

**Deliverable:** a new tenant produces their own criteria and fit brain without
writing a scoring rubric by hand.

Deferred to its own spec. Recorded here because it constrains C.

- Resume paste **and** file upload.
- A conversational intake, **text or voice**, that asks about experience, targets and
  constraints.
- Synthesis into `app_settings` for that tenant: target titles, location terms, stack
  terms, location rule, comp floor, and a first-person fit brain — the same keys
  `loadCriteria()` already resolves in `lib/search-criteria.ts`.
- A review screen. The user edits before anything is saved.

### Open questions for F's spec

- **Speech-to-text vendor.** Anthropic has no STT. Candidates: browser Web Speech API
  (free, uneven support), OpenAI Whisper, Deepgram, AssemblyAI. This is a **new
  vendor, a new credential and a new cost line** — the first non-Anthropic dependency
  in the app.
- **Who pays for onboarding?** It runs before the tenant has a key or has seen a
  budget. Recommendation: free and unmetered on the platform key, with a hard
  per-account lifetime allowance so a signup loop cannot be used as a free API.
- Audio storage and retention. Recommendation: transcribe and discard, store no audio.

---

## Testing strategy

Tests cover pure logic today (`lib/*.test.ts`), and `npm run build && npm test` is the
gate. `npm run lint` is non-functional and stays out of it.

New tests that are not optional, because each pins a failure that is silent:

| Test | Pins |
|---|---|
| Two tenants through one pooled connection | `SET LOCAL` discipline; a leaked GUC is a cross-tenant read RLS *permits* |
| Query builder rejects an unscoped tenant-table query | The app-layer half of isolation |
| Tenant-table registry matches the schema | A new tenant table cannot dodge classification |
| **Parallel** budget-exhaustion requests | The read-modify-write race; a sequential test passes against the broken version |
| Exception containing a full API key | The redaction boundary |
| Session past its absolute cap is rejected | Auth.js rolls `expires` forward and will not do this for us |
| Backup guard refuses a database with no app tables | A green backup job is not evidence of a backup |
| Empty board / careers-URL candidate ordering | Existing crawl invariants survive the split |

## Risks

- **C is a wide migration.** `jobs`, `app_settings`, `watchlist` and `insights_cache`
  all change shape, and `watchlist` splits into three tables. Backups must be working
  and a restore must have been tested before C starts. This is the whole reason A is
  first.
- **RLS misconfiguration is silent.** Every failure mode here looks like working
  software. The pooled-connection test is the load-bearing one.
- **The admin account becomes the highest-value credential in the system.** Full
  act-as plus waitlist control plus budget control. Its session policy is the same as
  everyone's; consider a shorter absolute cap for admin sessions.
- **`lib/supabase.ts` becomes genuinely load-bearing for security**, not just
  ergonomics. It should be reviewed as security-critical code from C onward.

## Deferred, deliberately

- Organizations and multi-member tenants. The `tenant_id` naming preserves the option.
- Paid tiers and billing. The three-tier model is designed so a paid tier slots in
  between free and BYO without reshaping metering.
- Rewriting git history to remove `.env.production`. Consequence: the repo cannot be
  made public until this is done.
- Per-tenant careers-URL overrides. The evidence-ranked candidate list should make
  them unnecessary; revisit only if a real conflict occurs.
