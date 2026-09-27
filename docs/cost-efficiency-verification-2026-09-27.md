# Cost efficiency implementation and verification

## Delivered behavior

Company checks prefer verified public boards and direct employer pages. Complete source snapshots retain the full observed listing set while paid processing targets new or meaningfully changed listings. Changed records have guarded updates that preserve user choices and notes. Incomplete, skipped, failed or search-only checks cannot close jobs.

Automatic paid web search is opt-in, initially off. Check now reads direct sources; Deep search may use up to five searches across the whole company check, including careers-page discovery. The separate By Role policy is unchanged. Repeated model-listing failures produce 7-, 14- and 30-day paid-search backoff after the second failure, while direct checks retain their schedule.

Background model work defaults to **$1/day and $10/month**, in UTC, in addition to existing overall limits. Zero pauses paid background work; null removes that additional cap. Cron checks, first checks on tracking, and scheduled grading use that allowance. Manual checks and manual grading retries use the overall allowance. Free source checks can proceed at a paid cap. In-flight requests can finish above the remaining dollar allowance; the five-search company limit is enforced in the provider request.

Every metered operation and provider request has durable accounting metadata. Usage and prices are stored separately from prompts/content. Known costs are recorded even when the response cannot be used; unknown outcomes retain an app reservation and remain explicitly unknown. Those reservations do not create additional provider charges. Concurrent siblings finish before final settlement, duplicate settlement is idempotent, and interrupted operations cannot accept late provider dispatch after recovery claims them.

Anthropic uses authoritative provider search counts and separate fresh/cache-read/5-minute-cache-write/1-hour-cache-write pricing. Hidden SDK retries are disabled. Explicit company filtering uses `web_search_20260209` on Sonnet 4.6 only, with the existing cap and no automatic continuation of `pause_turn`. Unsupported models and unrelated searches retain basic search. One shared capability helper determines the request and recorded mode.

Watchlist displays attempt/result, last successful check, next eligibility, backoff and recorded company costs. Unknown and historical unrecorded costs are distinct from confirmed zero; sub-cent amounts remain visible. Settings exposes background limits for both admins and members. Saving one limits form preserves unsaved edits in the other.

## Defaults and historical accounting

Only historical `crawl` usage is known to be automatic and seeds the background totals. Historical scoring origins and exact request/company costs are not invented. September's audited automatic usage exceeds the new $10 monthly default, so releasing these defaults would pause further paid background work until reset or a settings change. Direct checks would continue.

The audit identified $52.99 for AI-search company checks versus $1.46 for direct checks in the measured sample. These are observations motivating the changes, not a promised savings percentage. Lower production spending has not yet been measured.

## Verification

Final integrated verification on September 27, 2026:

- `npm test`: **2,268 passed, 16 skipped; 196 files passed, 2 skipped**. Baseline was 2,178 passing tests. The existing dynamic-import warning in the action-auth test remains.
- `npm run build`: **passed**, including the production type check. The build needed network access for its existing Google Fonts fetch. No dependencies were changed.
- `node scripts/verify-cost-controls.mjs`: **all 11 browser checks passed**, with zero browser errors and no horizontal overflow at 390px.
- `git diff --check`: **passed**. The repository's configured `npm run lint` command is nonfunctional under Next 15 and is not represented as a passing check.
- Three parallel implementation agents completed source, policy/accounting and provider work; the parent implemented the UI/schema integration. Independent cross-reviews closed every actionable finding. A fresh reviewer could not be created because the agent-thread limit was reached, so reviewers examined work they did not own.

- Provider tests use injected responses; no paid provider request or benchmark was run.
- Source, closure and refresh tests exercise ownership, effective criteria, partial/truncated sources, failed retries and concurrent user edits. Durable attempt ordering prevents failed early listings from starving later candidates; a summary-only grade cannot acknowledge a failed posting read.
- PGlite executes the real schema and every migration, repeated application of the new migrations, grants, forced RLS, cross-tenant writes, composite operation relationships, atomic rollback and idempotent settlement.
- Controlled interleavings exercise allowance refresh and sibling-call settlement. PGlite serializes transactions; this does not establish multi-connection PostgreSQL lock scheduling. Local server validation was unavailable because the installed libpq tools lack the `postgres` server binary.
- Mutation checks proved tests fail when employer corroboration, final New-status protection, authoritative search counts or unknown-cost reservations are removed; original files were restored and tests rerun.
- The browser regression script mounts real controls with synthetic records and mocked actions. It checks admin/member controls, both save forms, empty-string failures, toggle rollback, direct/deep routing, zero/null semantics, readback, preservation of unsaved drafts, browser errors and 390px overflow. Desktop/mobile screenshots were inspected.

Run browser verification with `node scripts/verify-cost-controls.mjs`. It uses the existing Vite/Playwright dependencies, starts an ephemeral localhost server and closes both server and browser in `finally`. macOS uses installed Chrome; set `COST_QA_BROWSER` for another installed browser. `COST_QA_PLAYWRIGHT_MODULE` optionally points to an already-installed Playwright module. Screenshots go to the printed temporary directory. No live account, database or API key is used.

## Release boundary

Implementation is retained on `codex/cost-efficiency`, based on production/origin main `5e5efa0`. No production migration, settings change, deployment or paid test occurred. The original checkout and its unrelated résumé work were preserved.

Release requires migrations **026–028** through the existing migration runner before serving the new build. Migration 025 is reserved for separate, undeployed chat work and is not part of this branch. Health verifies required columns and grants. Release should verify the exact deployed commit, authenticated Settings/Watchlist readback, and direct checks at a paid cap. Any live paid-search quality/cost comparison needs its own explicit spending bound.

Key-verification probes retain their documented exception outside operation metering. Provider HTTP refusals without reported usage remain conservatively unknown rather than assuming zero billing. Historical provider-dashboard differences remain unresolved by this forward-looking request ledger.
