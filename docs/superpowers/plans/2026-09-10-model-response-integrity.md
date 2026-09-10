# Model response integrity implementation plan

**Goal:** Fix the seven response-handling findings and use 50 as the default web-search allowance.

**Architecture:** Validate completion before parsing and validate data before persistence. Keep response errors distinct from evidence about a careers page. Split By Role query grids into bounded requests whose total search allowance remains within the selected limit.

**Scope:** Current local branch; no deployment or reconciliation of unrelated divergent commits in this change.

- [x] Add regression coverage for parseable incomplete answers, wrong envelopes, invalid scores/themes, recovery truncation, and bracketed narration.
- [x] Add shared response errors and completion checks; replace boundary slicing with balanced JSON extraction.
- [x] Validate search lists and recovery results; retain recovery provenance and safe error messages.
- [x] Validate scoring and résumé theme values before use; enforce completion for text-only model callers.
- [x] Stop counting AI and missing-URL outcomes as proof of unreachable careers pages.
- [x] Default every web search to 50; batch By Role queries and preserve useful partial results without caching them as complete.
- [x] Run regression tests, full suite and production build; review diff and commit the completed unit.

## Verification

- 2,037 tests across 154 files pass.
- Production build, including its lint/type validation step, passes.
- Mutation probes rejected bypassed completion checks, the old 32-search default, incorrect recovery array types, restored dead-page increments and discarded paid results.
- Independent code review found no blockers and reran 14 focused tests.
- No paid live search or production write performed.
