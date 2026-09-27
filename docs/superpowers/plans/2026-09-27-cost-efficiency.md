# Job Monitoring Cost Efficiency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Eliminate avoidable company-search spending, bound paid background work, and make every measured AI cost attributable.

**Architecture:** Three parallel backend streams own distinct source, budget/ledger, and provider files. They integrate through the interfaces below, followed by a UI stream and combined adversarial verification. Public listing collection stays separate from paid processing; one budget scope owns all accounting.

**Tech Stack:** Next.js 15.5.25, React 19.3.0, TypeScript, Postgres, Vitest/PGlite.

**Spec:** `docs/superpowers/specs/2026-09-27-cost-efficiency.md`

## Global Constraints

- No production writes, migrations, deployments, or paid API tests in this implementation task.
- Additive migrations 026 (source snapshots/evidence/closure), 027 (background policy), 028 (request ledger); 025 remains reserved for separate undeployed chat work.
- Preserve tenant RLS, cron auth, all user data, careers/profile neutrality, manual status/notes, and existing overall spending limits.
- Error strings are detected by presence, not truthiness. Incomplete model output is never empty-listing evidence.
- Agents only edit their assigned files. They do not commit, spawn subagents, or run full builds simultaneously. Parent coordinates integration and commits with the mandatory Skill candidate gate.
- Test focused changes before handoff. Parent runs full `npm test`, `npm run build`, and `git diff --check` after integration.

## Shared Interfaces (freeze before implementation)

Task 2 owns `lib/billing-context.ts`, `lib/crawl-policy.ts`, `lib/ai-attribution.ts`, `lib/types.ts`, and budget-store interfaces. Task 3 owns `lib/providers/types.ts` and `lib/model-call.ts`. Task 1 owns `lib/crawler.ts`.

```ts
// lib/crawl-policy.ts (Task 2)
export type CrawlTrigger = 'automatic' | 'check' | 'deep';
export const COMPANY_SEARCH_LIMIT = 5;
export function paidSearchDecision(input: {
  trigger: CrawlTrigger; allowPaidSearch: boolean;
  modelRetryAfter: string | null; now?: Date;
}): { allowed: boolean; reason?: string };

// lib/ai-attribution.ts (Task 2)
export interface AIAttribution {
  company?: string; crawlRunId?: string; jobId?: string;
  trigger?: 'scheduled' | 'manual' | 'on-track' | 'recovery' | 'other';
  phase?: string;
}
export function withAIAttribution<T>(value: AIAttribution, fn: () => Promise<T>): Promise<T>;

// Existing withBudget options gain (Task 2):
// workload?: 'foreground' | 'background'; allowFreeWork?: boolean;
// Existing BillingScope gains optional tenantId, action, workload, operationId.
// TrackCall owns recordUsage + incremental flush WHEN INSTALLED.
// Task 3 collect helpers must not recordUsage a second time in that case.
export interface AIRequestMeta {
  kind: 'complete' | 'search'; maxTokens: number; maxSearches?: number;
  searchMode?: 'basic' | 'filtered';
}
// BillingScope.trackCall?: (meta: AIRequestMeta,
//   fn: () => Promise<Completion>) => Promise<Completion>;
// runScope waits for tracked pending calls before one final reconciliation.

// Task 3 adds optional searchMode:'basic'|'filtered' to SearchOpts and
// callWithWebSearch/Detail opts. Completion gains providerRequestId,
// providerResponseId, usageSource. Usage gains optional cacheWrite5mTokens,
// cacheWrite1hTokens. Providers retain costCents; exact price helper also
// returns micro-USD and a serializable rate snapshot.

// Task 1 extends crawlCompany options with trigger?: CrawlTrigger.
// Default is 'check' (safe direct-only), callers Task 2 pass explicit mode.
// During search, limit remaining = COMPANY_SEARCH_LIMIT - searches already
// recorded in this operation, including careers URL discovery.
// Company + run attribution wraps paid work via withAIAttribution.
```

Minor signature adjustments require notifying the other owner and recording the agreed interface in the ledger. No duplicate policy or metering implementations.

## Review Focus

1. An unchanged or skipped source accidentally closes a job: Task 1 stores complete observed evidence separately and tests matched current/previous eligibility.
2. Concurrent user edits get overwritten by changed-posting refresh: Task 1 tests final UPDATE predicates and preservation of notes/status.
3. Failed/unknown provider requests are reported as free or double-billed: Task 2 tests unknown holds, idempotent settlement, pending siblings, and RLS; Task 3 validates usage before reporting.
4. Free checks disappear at paid cap or cron spins on skipped work: Tasks 1/2 test zero provider calls, future retry eligibility and progress to another company.
5. Filtered searches escape search limits or lose nested usage: Task 3 asserts exact request `max_uses` and authoritative provider counts different from visible blocks.

## Task 1: Verified sources, snapshots, and truthful crawl evidence

**Files owned:** `lib/crawler.ts`, `lib/crawler*.test.ts` except existing policy health tests reserved by Task 2; `lib/job-link.ts`, `lib/job-link.test.ts`, `lib/resolve-job-link.ts` and its tests, `lib/ats-boards.ts` and its tests, `lib/board-source.ts`, `lib/board-store.ts` and tests; new `lib/employer-board-evidence*`, `lib/crawl-snapshot*`; `lib/ingest-roles.ts` and tests if needed; migration `026_crawl_source_snapshots.sql`. Do not edit shared types, policy actions, metering, providers, schema/readiness registration, or UI without parent coordination.

**Consumes:** shared policy and attribution interfaces; new tracked-company fields from Task 2.
**Produces:** `crawlCompany(company,{dryRun?,ctx?,trigger?})`, source-verified direct collection, content/criteria-aware extraction cache, guarded change processing, persisted closure eligibility.

- [x] Add behavioral tests before implementation. A bare board URL linked by an employer is accepted; the same guessed URL without evidence is refused; multiple conflicting boards remain unresolved. Test transient 429/fetch failure retains old evidence and cannot close jobs. Use synthetic employers.
- [x] Add `parseBoardUrl` without changing `parseBoardLink` posting-only semantics. Parse actual employer anchors/embeds through existing safe fetch/robots controls. Store proof of link origin, not a self-asserted boolean. Separate provenance age from last fetch time; invalidate when the configured careers source changes.
- [x] Reorder board resolution before any paid URL lookup. Respect the policy decision before every fallback. Wrap model work with immutable company/run attribution; request filtered search explicitly, cap the total operation at five actual searches across discovery and fallback.
- [x] Implement pure snapshot canonicalization and tenant-scoped persistence. Cache only complete successful extraction; key by source, effective criteria including per-company override, and parser version. Distinguish observed from processed state so failed writes/grades retry.
- [x] Test meaningful changes and no-op changes with divergent fixtures:
```ts
// Mutation: dropping compensation/body from content identity must fail.
expect(fingerprint({...posting, salary:'200000'}))
  .not.toEqual(fingerprint({...posting, salary:'250000'}));
// Mutation: charging again for unchanged normalized page content must fail.
await runTwiceWithSamePageDifferentWhitespace();
expect(modelExtract).toHaveBeenCalledTimes(1);
```
- [x] Keep full observed titles for closure while processing only changed/new candidates. Never treat limited search, skipped, failed, or salvaged results as closure evidence. Persist `closure_eligible`, `source_key`, and `criteria_fingerprint`. Require both previous/current eligible matching evidence. Add final status predicate to closure UPDATE.
- [x] For changed existing records, use a named guarded refresh path limited to unacted crawler-owned New rows and current grading leases. Preserve manual notes/status and terminal rows. Test a status move occurring between selection and save.
- [x] Ensure dry runs issue no board/snapshot/crawl writes. A policy/budget skip updates truthful attempt/next-eligibility through the Task 2 contract and cannot spin. Coordinate required shared status names before using them.
- [x] Run focused source/crawler/ingest tests; safely falsify at least one source-trust or closure guard with backup/restore. Write report with files, tests, migration behavior and remaining integration needs.

## Task 2: Background admission, model backoff, and durable request ledger

**Files owned:** `lib/metered.ts`, `lib/billing-context.ts`, `lib/usage-store.ts`, budget/spend-limit store/types/tests, new `lib/ai-attribution*`, `lib/ai-ledger*`, `lib/crawl-policy*`; `lib/types.ts`, `lib/crawl-schedule.ts`, `lib/crawl-next.ts`, `lib/watchlist-row.ts`, related tests; `app/actions/watchlist.ts`, `app/actions/spend-limits.ts`, cron crawl routes, `lib/grading-worker.ts` and directly related tests; migrations `027_background_crawl_policy.sql`, `028_ai_request_ledger.sql`. Task 4 owns UI and schema/readiness registration. Do not edit crawler, provider or model-call implementations.

**Consumes:** normalized completion metadata/price helper from Task 3, attribution wrappers from Task 1.
**Produces:** shared interfaces above, atomic background controls, one durable operation/request ledger, tenant-scoped company cost summaries suitable for UI.

- [x] Write failing tests for policy defaults and budgets. Automatic/check cannot search unless explicitly permitted; deep permits at most five. By Role unchanged. Two model errors produce seven-day backoff; further failures 14/30 days; successful listing resets, budget/database/direct-fetch errors do not.
- [x] Add watchlist opt-in/backoff/attempt/success/eligibility fields and truthful `skipped`, `partial`, `unchanged` statuses if needed. Keep existing dead-page counters separate. Extend cron/action mode arguments and ensure automatic grading uses background workload.
- [x] Implement background settings with $1/day and $10/month defaults, zero pause, null additional-unlimited. Existing overall defaults/overrides are unchanged. Add authenticated save/read actions and safe DB error-presence handling. Use named `background:` counter periods and seed only known historic crawl usage.
- [x] Reserve all applicable windows atomically in a fixed order. Ensure a rejected later window leaves no earlier debit. Add allowFreeWork behavior so source collection can enter the scope when model admission is denied; `refreshAllowance` must still refuse all provider calls before dispatch. No nested double reservations.
- [x] Create generic `ai_operations`/`ai_usage_requests` tables with forced RLS, explicit tenant predicates and composite tenant-operation relationships. Before a provider call, persist request metadata and immutable attribution. Store only numeric usage/safe identifiers, never content/secrets.
- [x] Install `BillingScope.trackCall` as the usage collector; it records valid usage and flushes before returning even for incomplete responses. Task 3 skips duplicate collection when this hook exists. Track pending calls and await siblings before final settlement. Ledger rows do not independently debit counters.
- [x] Handle unknown provider outcome and process loss explicitly. Do not record missing usage as zero. Preserve at least the operation reservation; stale in-flight attempts become unknown without retrying AI. Add idempotent settlement and operation IDs to events. Historical exact cost remains null.
- [x] Test accounting invariants with controlled interleavings and database integration:
```ts
// Mutation: releasing unknown request cost as zero must fail.
expect(await settleTimedOutOperation()).toMatchObject({costComplete:false});
expect(await readReservedSpend()).toBeGreaterThan(0);
// Mutation: duplicate reconciliation debits twice must fail.
await settle(operation); const first = await readCounter();
await settle(operation); expect(await readCounter()).toEqual(first);
```
- [x] Publish tenant-safe company cost/outcome summary reader with known exact cost, unknown/in-flight count, latest cost/result and month-to-date period. Do not infer historical company costs by timestamp in the product. Publish names/types to Task 4 before it starts.
- [x] Run focused policy/budget/ledger/action/auth tests. Validate migration/grants/RLS with PGlite and distinguish its single-connection limit; use local Postgres concurrency only if available without modifying production. Write report with schemas/interfaces and unknown-state semantics.

## Task 3: Provider usage integrity and filtered company search

**Files owned:** `lib/model-call.ts`, `lib/providers/*`, relevant model-call/provider tests; new provider exact-price/error helper modules. Do not edit metered, billing-context, usage-store, crawler, shared product types or UI. Coordinate import types with Task 2.

**Consumes:** optional BillingScope.trackCall and context from Task 2.
**Produces:** complete metadata/usage envelope, integer micro-USD price helper, explicit filtered company-search option.

- [x] Add tests where provider-reported search count differs from both direct and nested tool blocks; provider count wins and authoritative zero stays zero. Missing, negative or malformed usage must produce a typed unknown-usage outcome instead of fabricated free completion.
- [x] Extend Usage with separate five-minute and one-hour cache writes. Preserve existing fresh/cached subtraction for other providers. Implement exact `costMicrousd`/price snapshot helper while retaining compatible cents pricing. Test fractional cents and mixed cache TTL costs.
- [x] Capture provider HTTP request ID separately from message/response ID through SDK withResponse or a narrow injected response envelope. Disable hidden retries. Preserve safe error classification without persisting raw bodies/keys.
- [x] Route complete/search through trackCall when installed. The hook owns recordUsage and flush; collect helpers skip the duplicate. Without hook, preserve existing test/script behavior. Usage must be collected before terminal reason validation or JSON parsing.
- [x] Add explicit `searchMode` option. Select `web_search_20260209` only for filtered Sonnet4.6 company calls, otherwise basic. Preserve `max_uses` and do not add a separate code tool. Do not auto-continue pause_turn.
- [x] Pin selection and cap behavior:
```ts
// Mutation: filtered mode drops max_uses or applies to unsupported model.
expect(body.tools[0]).toMatchObject({type:'web_search_20260209',max_uses:5});
expect(haikuBody.tools[0].type).toBe('web_search_20250305');
```
- [x] Run provider/model-call/pricing focused tests and a safe usage-count mutation check. No live provider requests. Report request shapes, pricing source links, error type contract, and any unmetered key-validation boundary.

## Task 4: Controls, company costs, migration registration, and integration

**Files owned:** `components/Watchlist.tsx`, `components/SpendLimitsPanel.tsx`, any focused display component/helper tests, `app/watchlist/page.tsx` if needed, `db/schema.sql`, `lib/supabase.ts` table registration, `lib/readiness.ts` and readiness/migration tests, relevant docs. This task starts as soon as interfaces from Tasks 2/3 exist, while source work can continue.

**Consumes:** Task 2 policy actions/summary reader and shared tracked-company status fields.
**Produces:** usable controls, truthful cost/status display, deploy-ready additive migrations.

- [x] Add independently editable background daily/monthly settings and effective defaults. Read back persisted settings after save. Show zero as paused, blank as no additional cap, and errors by presence with rollback.
- [x] Add automatic paid-search toggle and explicit Deep search label/cap. Ordinary Check now remains direct-only; the opt-in applies only to automatic checks. Refresh company data and costs after actions; surface saved-with-check-refused as saved, not failed.
- [x] Show last attempt/result, last successful check, next/backoff, latest/month cost, new-role result, and unknown accounting. Never label unrecorded history as zero. Use existing styling and accessible controls; do not expose implementation jargon.
- [x] Register new tenant tables in query-builder protection and required readiness schema. Keep migrations additive/idempotent, with grants and forced RLS matching existing conventions.
- [x] Test display transformations for error/skipped/partial/unchanged, sub-cent known cost, unknown cost, missing historical evidence, zero/null settings, and empty-string save errors. Verify authenticated action coverage.
- [x] Run focused tests, then parent-coordinated build/full suite. Write a concise verification report including mocked-versus-live limits and release checklist.

## Task 5: Independent review and final verification

- [x] Inspect each task report and diff; reconcile interface changes and run focused task tests after integration.
- [x] Independent cross-review examines source, policy/accounting, provider and UI work against spec: tenant boundaries, no false closure, count/budget bypass, unknown outcomes, concurrency, and actual UI wiring. Fix actionable findings and repeat scoped review. A fresh reviewer was unavailable because the agent-thread limit was reached; every reviewer examined files they did not implement.
- [x] Run `npm test -- --reporter=dot`, `npm run build`, and `git diff --check`; report actual results. Do not claim npm lint ran successfully because Next15 removed this repo's configured command.
- [x] Record local migration evidence and release requirements. No production changes or paid benchmark. Parent commits only scoped code/docs after mandatory `Skill candidate:` line.

## Completion evidence

Implemented on `codex/cost-efficiency` in an isolated worktree. Final verification: 2,268 tests passed (16 skipped), production build passed, all 11 browser checks passed, and diff checks passed. See `docs/cost-efficiency-verification-2026-09-27.md` for migration evidence, review limitations, defaults and release requirements. No production changes or paid provider requests occurred.

The user-requested second review used two fresh subagents and a parent review. Eight confirmed defects were fixed, with 23 added regressions. The new final gate is 2,291 tests passed (16 skipped), production build passed, all 11 browser checks passed, and diff checks passed. See `docs/cost-efficiency-second-review-2026-09-27.md` for findings and evidence. Production remains unchanged.
