# Missing-grade recovery

New open roles are saved with a grading lease before their initial scoring call.
Successful scoring writes the grade and rationale together. A failed attempt
records safe failure text, an attempt count, and the next eligible retry time.
Existing ungraded rows enter the same queue through migration 022.

The authenticated `crawl-next` cron route recovers one missing grade per request
before starting more company searches. It uses the existing tenant context,
provider routing, usage metering, and spending limits. Dry runs do not claim or
score roles. The response retains `crawled: true` for completed recovery attempts
so the existing cron driver continues; `kind: grading-recovery` identifies them.

Eligibility requires a missing grade, an open/non-hidden status, a live candidate
(`never_live=false`), an expired or absent lease/cooldown, and fewer than five
attempts. A row being rediscovered remains in this queue without being inserted
again. Existing grades, including manually assigned grades, are excluded.

Claims use one `UPDATE` with `FOR UPDATE SKIP LOCKED`. Each claim has a random
lease token and expires in 30 minutes if the process disappears. Final writes
require the same lease, tenant, still-missing grade, and still-open status.
Manually selected roles are not automatically filed below the fit cutoff; the
migration preserves existing `Added by URL` provenance.

Transient failures back off for 5, 30, 120, then 360 minutes. The fifth failure
requires an explicit retry. Credit/auth/model-access failures pause the tenant's
grading queue using `app_settings.grading_pause`. Resolve the provider issue,
then click **Retry missing grades** to resume. The button clears the pause and
resets eligible attempts without stealing live leases, then processes up to 25
roles in separate requests. Each request observes the usual spending limits.

The Roles page shows missing counts and failure messages. Search RPCs also have
a client deadline and `finally` cleanup; an interrupted search checks the saved
cache without buying another search. Client timeouts do not cancel server work.

## Release

Apply `db/migrations/022_grading_recovery.sql` using `db/migrate.mjs` before
deploying the new application code. It only adds columns/indexes and preserves
all existing grades. Existing table-level RLS and grants cover these columns.
Confirm the production migration ledger and deployed commit, then use the Roles
page's retry action to recover the current backlog and inspect persisted results.

## Verification

Tests execute claim/final-write/failure SQL with PGlite, exercise the worker with
mocked provider calls and real SQL persistence, cover metering refusal, stale
workers, chosen roles, and the cron's auth/dry-run/capped-tenant behavior. Browser
QA uses the real components with mocked RPC failures so it spends no API credits.
