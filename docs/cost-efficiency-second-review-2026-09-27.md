# Independent second review of cost-efficiency changes

Reviewed commit `8c27ee8` against base `5e5efa0`. Two fresh subagents independently reviewed accounting and crawler/source behavior while the parent reviewed provider errors, policy callers, controls, schema registration and integration. The agent limit prevented a third reviewer and reuse of an earlier agent; this was two subagent reviews plus a parent review, not three fresh subagents.

## Confirmed findings and fixes

| Severity | Finding | Fix |
|---|---|---|
| P1 | A changed posting could overwrite manual compensation, department or fit-score edits made before the check began. The timestamp guard only protected edits made during the request. | Add a server-controlled `crawl_refresh_protected` marker. Manual creation and edits to fields owned by refresh protect the record. Claim and final save both enforce it. Existing records are conservatively protected because their historic edits lack sufficient provenance. Future automated records remain refreshable. |
| P2 | Changing a careers URL could reattach the previous employer board through fallback discovery. | Require new source evidence after a source change; do not resurrect the old board or a guessed board without corroboration. |
| P2 | When a changed source omitted compensation/location, grading received empty values even though persistence retained the existing values. | Resolve retained values once and use them for both grading and storage. |
| P2 | Changed-posting refresh bypassed the excluded-source and posting-admission checks used for new jobs. | Apply the same admission rules before reading or grading; rejected updates are handled without repeated paid attempts. |
| P2 | Stale recovery labeled fully known or never-dispatched work as uncertain, retaining an unnecessary reservation. A known 1-cent request could hold 11 cents; no dispatch could hold 10 cents. | Derive uncertainty from durable request states after recovery claims the operation. Keep holds for genuinely unknown requests; settle known-only and no-dispatch work without an extra hold. |
| P2 | Company month totals omitted costs saved at operation level when request-detail persistence failed, despite displaying the known amount for the latest check. | Reconcile request and operation evidence without duplicate totals, retain company attribution boundaries, and count work in its operation's UTC start month consistently with spending allowances. |
| P2 | If completed usage was saved but the following activity-heartbeat write failed, the caller mislabeled the durable cost as unknown and retained an extra hold. | Treat the post-completion heartbeat as advisory: log its failure safely while preserving the known usage and settlement. Request admission still updates activity and enforces the operation lock. |
| P2 | Wrapping Anthropic errors discarded the insufficient-credit classification and told users to fix a valid API key. | Preserve a safe billing-blocked classification and give the credit/billing remedy without retaining provider error text or secrets. |

## Evidence and limits

Every finding was reproduced before its fix using synthetic provider responses or local database tests. Additional cases cover migration replay, existing-record protection, future-record defaults, manual insert/patch boundaries, unknown outcomes, shared operation attribution and month boundaries. The parent reviewed the resulting changes and owns the combined verification gate below.

Final integrated results after all eight confirmed findings were fixed:

- `npm test`: **2,291 passed, 16 skipped; 196 test files passed, 2 skipped**. This review added 23 passing regressions beyond the original implementation's 2,268-test checkpoint.
- `npm run build`: **passed**, including production type checking.
- Browser regression: **all 11 checks passed**, no browser errors, and 390px content width matched the viewport.
- `git diff --check`: **passed**. No temporary review tests remain in the repository.
- Independent reviewer verification: source/ownership checks **108 tests passed**; accounting checks **36 tests passed**; independent readback of the parent provider fix **21 tests passed**.

Every confirmed finding is resolved. The proposed partial-array extraction defect was disproved: the existing parser rejects malformed supplied items as a whole. Known-only recovery, mixed unknown holds and duplicate-total mutations were checked; modified files were restored before the final gate. The heartbeat regression exercised actual request admission, durable completion and settlement with a database trigger that fails only the advisory update.

The filtered Anthropic request shape, automatic code-execution provisioning and search cap were checked against the [official web-search documentation](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool). This confirms the documented contract, not a live paid-provider result.

Local database tests use PGlite, which serializes transactions and cannot establish real multi-connection PostgreSQL lock scheduling. No production writes, deployment, dependency installation or paid provider calls were performed. Explicit provider refusals with no usage remain conservatively unknown under the existing documented policy; the review did not reinterpret a missing usage report as a confirmed zero charge.

The new protection field is included in migration 026 because this branch has never been deployed. That migration protects existing records only on first application; replay does not disable refresh for subsequently inserted automated records. Existing manual values are retained rather than reconstructed from guesses.
