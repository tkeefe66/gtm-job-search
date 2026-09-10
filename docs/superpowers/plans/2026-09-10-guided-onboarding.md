# Guided onboarding implementation plan

> **For agentic workers:** Use executing-plans for implementation and dispatching-parallel-agents for the independent server and UI work after agreeing on the contract below.

**Goal:** Replace the advanced onboarding form with the user-approved guided wizard, preserving real résumé upload, BYO keys, and coherent profile generation.

**Architecture:** A separate tenant-scoped wizard draft stores answers, current step and generated profile without changing the active profile. Generation is explicit and metered. Finalization accepts only the saved generated version corresponding to the current answers. Company preferences feed existing discovery, and explicitly selected companies are added without triggering a paid crawl.

**Tech Stack:** Next.js 14, TypeScript, Postgres, existing provider adapters and Vitest.

**Spec:** Approved in this conversation and represented by the interactive mockup at `/tmp/signup-qa/wizard/index.html`.

## Constraints
- Every action starts with requireActor; use explicit tenant scoping and presence-based error handling.
- No résumé, key, or full generation response in logs. No automatic paid calls on mount or retry.
- Do not edit AGENTS.md. No deployment or push.
- Tools express desired future work, not evidence of existing experience.
- Funding stages constrain funding matches only; funding is not proof of hiring.
- Changes after generation invalidate the generated version; refreshing must retain a valid completed generation.

## Shared interface
`lib/onboarding-wizard.ts` exports `WizardAnswers`, `WizardDraft`, `emptyWizardAnswers()`, `resolveWizardAnswers(raw)`, and `wizardStepError(answers, step)`.

WizardAnswers fields: `mode: "questions" | "resume"`, `current`, `resume`, `wanted`, `titles: string[]`, `tools: string[]`, `location`, `workModes: string[]`, `locationImportance: "preference" | "required"`, `priorities: string[]`, `compFloor: string`, `travel`, `exclusions`, `industries: string[]`, `companies: {name: string; careersUrl: string}[]`, `signals: ("hiring" | "funding")[]`, `fundingStages: string[]`.

WizardDraft fields: `answers`, `step: number`, `generated?: GeneratedProfile`. Steps 0 background, 1 roles, 2 tools, 3 location, 4 priorities, 5 dealbreakers, 6 industries, 7 companies, 8 signals, 9 key/generation, 10 review.

`app/actions/onboarding-wizard.ts` exports:
- `getWizardState(): {draft: WizardDraft; onboardedAt: string|null; isAdmin: boolean; error?: string}`
- `saveWizardProgress(answers: WizardAnswers, step: number): {error?: string}`
- `generateWizardProfile(answers: WizardAnswers): {profile?: GeneratedProfile; capped?: string; error?: string}`
- `finishWizardOnboarding(answers: WizardAnswers): {error?: string}`
- `clearWizardProgress(): {error?: string}`

## Task 1: Draft, generation and discovery behavior
Implement and test the shared interface, strict input validation, draft storage and legacy-answer hydration. Store generated results server-side and refuse finishing a stale generation. Reuse existing metering and atomic profile save. Validate names and careers URLs; preserve existing company identity and URL precedence; prevent a paid crawl during setup. Test failure presence, tenant isolation, conflicting inputs, desired skills versus experience, funding/hiring combinations, stage exclusions, and stale generation rejection.

## Task 2: Wizard interface
Replace `components/Onboarding.tsx` with a coordinator and focused question/review components. Reuse real `readResumeUpload` and `ApiKeyPanel`. Save on forward/back/skip and debounce text edits with a visible status. Serialize saves to avoid response-order races. Keep generation explicit. Review exposes generated titles, location and fit summary alongside confirmed preferences; edits return to their question and require regeneration. Provide a provider-aware first-action screen and retain a rescore offer for existing profiles.

## Task 3: Verification
Run focused behavioral tests, full Vitest suite and production build. Exercise a browser harness that imports the real UI but mocks network actions, including refresh, edit/regeneration and upload feedback. Inspect for auth/tenant/paid-call regressions, fix findings, and commit the coherent implementation locally. Live API/OAuth verification requires a separate fresh-account exercise and is not claimed by these checks.

## Implementation result

All three tasks implemented. The tenant draft lives in `app_settings` under `onboarding_wizard_draft`; no schema migration is required. Generation results are bound to normalized answers and finalization rechecks them inside the profile-save transaction. Explicit companies join the Watchlist at completion without an immediate crawl. Subsequent scheduled checks use the tenant's AI account.

Verification: production build passed; 145 test files and 1,962 tests passed. Browser harness using the real React components and simulated actions exercised progress recovery after refresh, company URL confirmation, optional funding with any stage, key connection, generation, review recovery, edit invalidation, regeneration, and completion. Review identified two clear-progress issues; both fixed and re-reviewed: invalid answers cannot prevent clearing, and a pending résumé upload cannot restore cleared answers. Real OAuth, database persistence, résumé parsing through the UI, and paid provider requests remain separate release smoke checks. Nothing deployed.
