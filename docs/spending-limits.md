# Spending limits

Users can set optional daily and monthly USD limits under Settings → Spending limits.
Blank means no app limit for that window; zero pauses AI work. Limits apply to work
through this app, including scheduled crawls, searches, scoring, and résumé actions.
They do not change provider-side limits or cover API key validation and usage elsewhere.
No BYO account receives an invented default. Admin accounts retain the existing
enforced defaults/overrides and edit them on Accounts.

The Accounts table displays the same saved BYO values as Settings. Unset values say
“Not set.” Administrators do not edit these user-selected limits through that table.
Saving limits changes new work immediately and never resets recorded spending.

## Storage and enforcement

- BYO limits live in the tenant-scoped `app_settings` row `spend_limits`, with integer
  `dailyCents` and `monthlyCents` values or null. Existing `users.*_budget_cents` rows
  remain the admin-only source; legacy BYO values in those columns are ignored.
- `saveSpendLimits` gets tenant identity from the authenticated actor. It accepts no
  tenant ID, validates both fields, and writes under the tenant's RLS scope. No migration
  is required. Invalid stored values and failed reads fail closed.
- `withBudget` reserves an estimate atomically against both applicable windows. A
  monthly refusal rolls back the daily reservation. A zero limit rejects even a zero
  estimate. The BYO key/payer is unchanged when caps are enabled.
- Before each model request, the scope refreshes current limits and persisted spending,
  adds back its own outstanding reservation, and subtracts its accumulated actual usage.
  Completed responses publish any cost above the reservation immediately, so other
  actions see that usage even before post-processing completes.
- Final reconciliation releases unused estimates and records the usage event in the
  same transaction as both counters. Errors are surfaced and logged. Missing historical
  BYO counters are seeded from usage events before updates; read-only views fall back to
  those events without resetting spend.

## Limits of the protection

Requests already in flight can cost more than their estimate and take spending above
a cap. This is an app-level control based on observed usage, not a provider billing
guarantee. No claim is made to recover billing usage absent from a failed provider
response. Gemini cannot enforce a search count cap, so capped searches refuse instead
of silently running uncapped; the Settings panel explains this for Gemini users.

Periods use UTC. A multi-request action is attributed to the day/month when it began,
including work spanning midnight; the Settings copy calls this out. Raising or removing
a limit does not change the period or spending history.

## Verification

`npm test` includes tenant spoofing, invalid inputs, independent windows, zero/unset,
read/write failures, nested calls, and concurrent action checks. The PostgreSQL tests
in `lib/usage-store.integration.test.ts` execute production SQL using PGlite and the
repository's metering migration, including RLS, historical seeding, refusal rollback,
incremental usage, and final reconciliation. PGlite serializes transactions; it verifies
SQL transaction behavior but does not simulate PostgreSQL's multi-connection lock scheduler.

Local browser verification uses the real Settings component and server actions with
synthetic actors and an isolated database; it covers save/reload, zero pause, invalid
daily/monthly ordering, and clearing limits. No real user's budget is changed by QA.
