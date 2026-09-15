# Job Dispositions Implementation Plan

> Execute in this session with subagent-driven-development for the independent persistence unit and a final review.

**Goal:** Add the approved five dispositions and source reporting for future activity.
**Architecture:** Add immutable source snapshots and event history with database triggers, tenant-scoped writes, and a report assembled from source snapshots and latest events. Existing status configuration remains authoritative.
**Tech Stack:** Next.js, TypeScript, Postgres, Vitest/PGlite.
**Spec:** ../specs/2026-09-14-job-dispositions.md

## Constraints
- No historical review, rewrites, or inferred legacy reasons.
- Five dispositions only; optional fit reason, no automatic blocking.
- Current manual selections and automatic outcomes remain separate.
- Every write is tenant-scoped and reports empty-string errors by presence.

## Tasks
- [ ] Persistence: migration 024, trigger and RLS tests, source snapshot/event models, atomic disposition action, user/automation attribution across writes. Prove missing tenant scope returns no data, event failure rolls back status, repeat writes create no duplicate event, and old rows remain untouched until a new transition.
- [ ] Pure source grouping/report and UI: shared disposition mapping, single/bulk controls, optional reason modal, source report with sample sizes and legacy cohort. Test host boundary parsing, repeated events, current versus historical outcomes, and unknown URLs.
- [ ] Integrate and review: auth contract, production build, complete test suite, UI smoke with synthetic records; inspect diff and resolve review findings.
- [ ] Commit the validated unit. Verify deployment target and additive migration if releasing; verify exact deployed SHA and live source page without buying model calls.

## Execution record
- Starting from 457a0a2 in /private/tmp/gtm-builtin-release, branch codex/job-dispositions. Original workspace and unrelated files are preserved.
- Feature implemented in 8a6c7bd; all 2,178 tests passed, final production build passed, review findings resolved.
- Local production-build browser verification passed with a synthetic non-admin account: single disposition, editing/preserving fit reason, automation-to-user confirmation, reopening, bulk duplicate, report, desktop/mobile widths. Synthetic account and all associated jobs/source/events were cleaned up. Local server stopped.
- Production migration 024 was applied at 2026-09-15T00:06:16Z. Before/after 289-job fingerprint matched; saved_resumes=1, tailored_resumes=12, builder_documents=0, settings=30 remained unchanged. Zero historical source rows/events were created by migration.
- RELEASE BLOCKED: automatic approval review rejected pushing HEAD to main because build authorization was not explicit deployment authorization for this feature. Current production code remains 457a0a2. Ask user for explicit deployment approval before pushing.
- A proposed pause of the new tracking triggers was also rejected; NO pause occurred. Triggers remain active with the old app. Pending-period writes can lack intended actor attribution. Do not claim the new UI is deployed. After approval, verify origin/main, push this reviewed branch, wait for exact Railway terminal success, and check live health/source page. Do not replay migration 024 or backfill historical records.
