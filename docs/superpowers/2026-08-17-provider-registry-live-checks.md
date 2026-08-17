# Provider registry (step 1) — live checks

**DEPLOYED 2026-08-17.** `main` at `b4f3caf`, 820 tests / 55 files, build green.
Migration `007_provider_routing.sql` applied to production before the push, in
that order, because the deployed code selects columns that did not exist.

Plan: `docs/superpowers/plans/2026-08-17-provider-registry.md` (Task 8).
Spec: `docs/superpowers/specs/2026-08-17-model-agnostic-design.md` (revision 2).

Everything below was run against production. **The checks a signed-in human has
to perform were NOT run and are listed as such at the bottom — they are
outstanding, not passed.**

## What shipped

Every model call now resolves its provider, key and model from the tenant's
stored config through `lib/providers/`. `lib/anthropic.ts` is gone; `export const
MODEL` and `clientFor()` with it. The two raw-SDK holdouts — `scoreFit`, the
per-role call inside `ingestRoles`' 25-way `Promise.all`, and `saveApiKey`'s
validation — are on the interface. Anthropic is the only adapter;
`providerFor("openai")` throws, and a test pins that it does.

## Checks run

**1. Backup taken before the migration.** ✅
`gtm-job-search/2026-08-17.sql.gz`, 38,952 bytes, uploaded to R2. The guard
passed with 7 app tables present.

**2. Migration dry run.** ✅
`7 migration(s) on disk, 6 already applied` → exactly one pending,
`007_provider_routing.sql`. Nothing else was waiting to ride along.

**3. Migration applied.** ✅
`applying 007_provider_routing.sql ... ok`. Verified afterwards by reading
`information_schema.columns`: `tenant_api_keys` now carries `provider`, `model`
and `aad_version`, and `pg_constraint` shows
`tenant_api_keys_provider_check CHECK (provider = ANY (ARRAY['anthropic','openai','google']))`.

**4. Deployed commit matches.** ✅
Recorded the pre-push deployment id (`982b4f96…`, at `28acbfb`) BEFORE pushing,
then polled keyed on the deployment **id** rather than on status — otherwise the
previous deployment's `SUCCESS` reads as this change being live. New deployment
went `BUILDING → BUILDING → SUCCESS` at
`b4f3caf56843e5436f2878d4e3cc9ee72e7d3b24`, equal to both `git rev-parse main`
and `git rev-parse origin/main`.

**5. The platform path, end to end.** ✅
`GET /api/cron/crawl?dry=1` with the crawler's `CRON_SECRET` → **HTTP 200**,
`{"dryRun":true,"crawled":0,"totals":{"newRoles":0,"failed":0},"results":[],"links":null}`.

`crawled: 0` does NOT weaken this check. `withBudget` is entered per tenant at
`app/api/cron/crawl/route.ts:106`, *before* `getDueCompanies`, so the run
executed `loadTenantKey`'s new `select … provider, model, aad_version` against
the production database on the deployed build. Had the columns been missing, the
rewritten error path would have surfaced it rather than swallowing it.

**6. The v1-AAD backward-compatibility path.** ✅ **— not applicable, and that is
the finding.**
The plan's Task 8 gained a step for this because it is the one thing in the
branch that cannot be tested locally and cannot be undone by a redeploy: rows
sealed before the AAD widened must still open, and a failed open is
indistinguishable from "no key stored". Queried production directly:
**`tenant_api_keys` holds zero rows.**

So there was never anything to break. The versioned AAD is still correct and
still tested — the next key saved will be `aad_version = 2`, and the v1
construction remains supported with its own tests, including the negative case
that a v1 row must still refuse to open under a different tenant. But the
migration's frightening property had no blast radius in production, and it is
worth writing down that the risk was measured rather than assumed away.

## NOT run — outstanding, needs a signed-in human

None of these can be driven from a terminal. They are the remainder of Task 8.

- **`/settings` renders the key panel.** Confirm the model field appears (it now
  renders whether or not a key is stored), that its copy states that changing the
  model means pasting the key again, and that the "~$X per By Role run" estimate
  reads the same as it did before this work.
- **A bad key is refused.** Save `sk-ant-nope` → *"Anthropic rejected that key.
  Check it and try again."*
  Note the correction the fix wave made to this step: a **second** rejected key
  within a minute returns the SAME rejection sentence, not the rate-limit
  sentence. The gate reads `last_verified_at`, which is stamped only on a
  successful save, so two rejected attempts write nothing. The plan previously
  asserted the rate-limit sentence here and would have recorded a failed check
  against working code.
- **An unpriced model is refused.** Save a valid key with model
  `claude-opus-4-1` → refused with the closed-set sentence naming what is
  accepted. This gate exists because `ANTHROPIC_PRICES` has one entry and
  `anthropicPrice()` falls back to Sonnet's rate: without it, an admin on Opus is
  metered at roughly a fifth of real spend and the daily runaway cap passes about
  5× the intended dollars.
- **Watchlist → "Check now"** on one company returns roles with fit scores
  filled in. This is the live check for `scoreFit` routing through the registry;
  the fit column populating IS the assertion.

## Known and accepted, carried forward

- **`ANTHROPIC_PRICES` has exactly one entry**, so the free-text model box
  accepts precisely one value while its copy reads "Optional." Populating the
  table is the real fix and belongs with the OpenAI adapter.
- **The unpriced-model gate is save-time only.** A pre-existing row whose model
  is outside the table would still route and still meter at the default rate;
  nothing sweeps at spend time. Unreachable today — there are no stored keys.
- **`saveApiKey` remains a key-validation oracle during a database outage.** The
  rate-limit gate reads a row; when the database is unreachable the gate opens
  and a live billable probe still fires before the insert fails. Pre-existing,
  unchanged by this work, and it needs its own ticket rather than a line in a
  refactor.
- **`CLAUDE.md:48` names `lib/anthropic.ts`**, which this branch deleted. Exactly
  one line of that file is stale — all 174 were checked. Unfixed because this
  repo forbids editing CLAUDE.md without the owner's explicit confirmation.
- **The spec still shows `validateKey(key): Promise<boolean>`**
  (`specs/2026-08-17-model-agnostic-design.md:109`). The fix wave changed it to
  take a model, so the OpenAI adapter would otherwise be written against a
  signature that no longer exists.
