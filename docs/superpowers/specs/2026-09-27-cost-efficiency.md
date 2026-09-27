# Job monitoring cost efficiency

## Outcome and authorization

Reduce money spent rediscovering unchanged job listings and retrying unusable AI responses while preserving source verification, useful job coverage, tenant isolation, and user-managed job state. The user approved all five recommended fixes and explicitly requested planning followed by parallel subagent implementation on September 27. Work stays in an isolated branch based on production commit `5e5efa0`; release, production migrations, and paid provider benchmarks are separate actions.

The measured opportunities were $52.99 in AI-search company checks versus $1.46 in direct checks, $13.95 in failed checks, and incomplete provider reconciliation. These observations are motivation, not guaranteed savings.

## Behavior

### Verified sources and changed listings

Prefer verified employer boards, then direct employer pages, then an explicitly permitted bounded AI search. Try known boards before paying to discover a careers URL. Recognize bare vendor board links without widening the posting-link parser's contract. Employer-page links or existing trustworthy employer identity corroboration establish source ownership; a successful guessed board URL alone never does. Evidence expires independently of ordinary successful fetches. Transient failures retain known sources and do not become durable negative cache entries. A changed careers URL invalidates old source evidence. Dry runs write no board or snapshot state.

Store tenant-scoped snapshots keyed by source identity, effective criteria, and parser version. Stable listing IDs and normalized meaningful content identify changes. Ignore ordering and whitespace noise; preserve meaningful compensation, location, title, and body changes. Cache only successful complete extraction. Failed processing remains retryable by separating observed state from processed state. Reuse unchanged direct-page extraction before any model call. Already known records retain existing dedupe behavior. Any changed-listing refresh is an explicit guarded path: it cannot change user status, notes, terminal records, or manual choices, and it must recheck those guards when saving.

Keep full observed listing evidence separate from the subset needing paid processing. Persist `closure_eligible`, source identity, and criteria identity on each crawl run. Require matching current/previous eligible runs for closure. Partial, skipped, failed, salvaged, or paid-search results cannot close jobs. Final closure updates must recheck `status = 'New'` to respect concurrent user edits.

### Bounded fallback and background spending

Company triggers are `automatic`, `check`, and `deep`. Tracking a new company and cron use automatic. Existing Check now checks direct sources. A separately labeled Deep search permits up to five paid searches for the entire company operation, including careers-URL discovery. Automatic paid search is opt-in, initially off. By Role retains its existing independent 50-search policy. Providers that cannot enforce caps continue to refuse bounded searches.

Automatic model work, including cron grading recovery and immediate checks on tracking, uses a background workload. Existing overall limits remain unchanged. Add background limits with explicit effective defaults of $1/day and $10/month; zero pauses, null removes only that additional limit. The UI states these defaults. Known historic `crawl` spending seeds the background counters; unknown historic scoring origins are not invented. This account's observed September automatic usage already exceeds the proposed monthly default, so release would pause further paid background work until reset or a settings change. Free source checks still run at a paid limit.

Reserve overall daily/monthly and background daily/monthly windows atomically in a fixed order. Use one accounting owner for reservation, incremental debit, and final reconciliation. Never wrap a second nested budget: nested scoring shares the original scope. Allow free work through a budget scope with exhausted paid allowance, while refusing every provider dispatch before it starts. Distinguish configured limits from strict per-request dollar guarantees: in-flight requests can finish above the remaining allowance, while search count is hard-capped.

Track model failures separately from page health. After two consecutive failed model listing attempts, automatic paid search backs off seven days, then fourteen, then thirty. Manual Deep search may retry. Success resets model failures; free unchanged checks, budget refusals, database failures, and direct HTTP errors do not. Attempt timestamps and successful-check timestamps remain distinct. Deferred/partial/error states are visible, never fabricated as empty. Scheduling must not repeatedly select a skipped company in one cron loop.

### Exact request accounting and filtered search

Record an operation and each provider request durably before dispatch, with tenant, action/workload, company/run/job attribution, provider/model, requested limits, search mode, request/response IDs, stop reason, numeric usage, and pricing snapshot. No prompts, API keys, raw responses, or search-query text are stored in this ledger. Attribute concurrent requests with immutable AsyncLocalStorage contexts.

Known usage is recorded and charged even when output is incomplete or cannot be parsed. Missing/invalid usage, timeouts, ambiguous failures, process interruption, or failed response persistence remain unknown, never free. Preserve an uncertainty reservation. Stale requests can be marked unknown without retrying the provider. Settle once; wait for sibling in-flight calls before settlement. Keep legacy counters authoritative; exact request rows are audit detail, not a second debit. Historical approximate cents remain explicitly approximate.

Provider prices use integer micro-USD. Anthropic distinguishes fresh input, cache reads, five-minute writes and one-hour writes. Use provider-reported web-search request usage, including zero, rather than visible/nested tool blocks. Provider SDK retries are disabled so one attempt means one physical request. Capture safe provider identifiers. Existing key-validation probes may remain outside tenant operation metering only if that small, explicit boundary is documented; do not introduce billing recursion to log key verification.

Use `web_search_20260209` dynamic filtering for explicitly requested company fallback on supported `claude-sonnet-4-6`; basic search remains for other models and unrelated search surfaces. Preserve `max_uses`. No separately added code-execution tool. Do not automatically continue a `pause_turn`; record usage and return incomplete. Mocked request/response tests validate this implementation; live cost/quality improvements remain unmeasured until an authorized bounded benchmark.

### Visible controls and evidence

Watchlist shows automatic paid-search opt-in, explicit Deep search, last attempt/result, last successful check, next eligible attempt/backoff, and company cost/new-role results. Show unknown cost distinctly, and distinguish zero recorded AI cost from unrecorded historical cost. Settings exposes editable background limits with readback and effective defaults. Existing tenant auth and string-error-presence contracts apply to all added actions.

## Constraints and validation

- Next.js 15.5.25, React 19.3.0, TypeScript, Postgres, Vitest; no dependency upgrade required.
- Additive migrations 026 (source snapshots/evidence/closure), 027 (background policy), 028 (request ledger); 025 remains reserved for separate undeployed chat work.
- No production writes, migrations, deployments, or paid API tests in this implementation task.
- Preserve tenant RLS, cron auth, all user data, careers/profile neutrality, manual status/notes, and existing overall spending limits.
- Error strings are detected by presence, not truthiness. Incomplete model output is never empty-listing evidence.
- New tests name the incorrect behavior they would detect; use meaningful behavioral assertions and safe temporary mutation checks for critical guards.
- Run focused tests, full `npm test`, `npm run build` (production typecheck), and `git diff --check`. The repository's `npm run lint` is nonfunctional; do not add a fake passing lint claim.
- Review the combined branch independently for cost bypass, false closure, accounting races, and cross-tenant access before completion.

## Delivery

Deliver the complete implementation with a verified local build, tests, migration readiness, written verification evidence, and a retained feature branch. Do not claim lower production spending until deployed and measured.
