# Universal Resume Builder Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement this plan with focused tests and review.

**Goal:** Create tenant-owned new resumes from reviewed content with distinct templates, fixed page limits, individual suggestions, and PDF export.

**Architecture:** New independent builder documents coexist with legacy saved resumes. Typed profiles and revisions drive both HTML previews and isolated Chromium render validation. The database owns proposal acceptance and immutable snapshots.

**Tech Stack:** Existing Next.js, TypeScript, PostgreSQL, model-call/withBudget; isolated Playwright Chromium worker.

**Spec:** docs/superpowers/specs/2026-09-14-universal-resume-builder-design.md

## Global Constraints

- No fallback to shipped career data or themes; no edits to legacy frozen documents.
- Imported text is reviewed before creating a document. PDF/DOCX/TXT use existing bounded extraction.
- New drafts are independent of jobs, optional job IDs must belong to the same tenant.
- All suggestions are individual proposals; accept exact stored text against expected revision.
- One/two page maximum, Letter/A4, no auto-shrinking or hidden content.
- Rendering and PDF export are authoritative on server-owned snapshots; external requests disabled.
- No deployment or push in this implementation session.

## Shared interfaces

Use lib/resume-builder-model.ts for these definitions. Keep content plain text; sanitize punctuation at validation.

```ts
type BuilderTemplate = 'classic' | 'editorial' | 'sidebar';
type BuilderSection = { id: string; title: string; entries: { id: string; heading: string; subheading: string; dates: string; bullets: {id:string;text:string}[] }[] };
type BuilderProfile = { name: string; headline: string; contact: string; summary: string; sections: BuilderSection[]; sourceText: string };
type BuilderDesign = { template: BuilderTemplate; pageLimit: 1|2; pageSize:'letter'|'a4'; accent: 'slate'|'blue'|'green'; font: 'sans'|'serif' };
type BuilderDocument = {id:string; revision:number; title:string; jobId:string|null; profile:BuilderProfile; design:BuilderDesign; updatedAt:string};
type BuilderProposal = {id:string;documentId:string;revision:number;target:string;before:string;after:string;reason:string;status:'pending'|'accepted'|'rejected'|'stale'|'blocked'};
type BuilderVersion = {id:string;documentId:string;title:string;createdAt:string;expiresAt:string};
type BuilderResult<T> = {data:T;error?:never}|{data?:never;error:string};
```

Stable proposal targets: `summary`, `headline`, `bullet:<id>`, `entry:<id>:heading`, `entry:<id>:subheading`. Empty replacement is not deletion. Deletion/reorder handled by explicit user profile editing initially; model proposal kinds are text replacements only, and tailoring must not silently select/drop/reorder content. All content can be directly edited through the review form; those changes are explicit user actions, not automatic model changes.

Public async actions in app/actions/resume-builder.ts:

```ts
getBuilderLibrary(): Promise<BuilderResult<{documents:BuilderDocument[];profile:BuilderProfile|null}>>
getBuilderDocument(id:string): Promise<BuilderResult<{document:BuilderDocument;proposals:BuilderProposal[];versions:BuilderVersion[]}>>
parseBuilderProfile(text:string): Promise<BuilderResult<BuilderProfile>>
createBuilderDocument(input:{title:string;profile:BuilderProfile;design:BuilderDesign;jobId?:string}): Promise<BuilderResult<BuilderDocument>>
updateBuilderDocument(id:string,revision:number,input:{title:string;profile:BuilderProfile;design:BuilderDesign}): Promise<BuilderResult<BuilderDocument>>
suggestBuilderChanges(id:string,revision:number,instruction:string): Promise<BuilderResult<BuilderProposal[]>>
acceptBuilderProposal(id:string,revision:number): Promise<BuilderResult<BuilderDocument>>
rejectBuilderProposal(id:string): Promise<BuilderResult<null>>
saveBuilderVersion(id:string,revision:number): Promise<BuilderResult<BuilderVersion>>
restoreBuilderVersion(id:string,revision:number,versionId:string): Promise<BuilderResult<BuilderDocument>>
deleteBuilderDocument(id:string,revision:number): Promise<BuilderResult<null>>
```

Renderer interfaces in lib/resume-builder-render.ts:

```ts
builderHtml(profile:BuilderProfile,design:BuilderDesign): string // complete self-contained trusted HTML
renderBuilderPdf(profile:BuilderProfile,design:BuilderDesign): Promise<{pdf:Buffer;pageCount:number}> // throws descriptive failure if overflow/glyph/font/render errors
```

Renderer preview uses same HTML in a sandboxed iframe. Preview is advisory; server candidate validation gates acceptance/export. No browser-submitted HTML reaches renderer. Export authenticated route `/api/resume-builder/[id]/pdf` resolves tenant document server-side.

Capability: `RESUME_BUILDER_ENABLED=true` enables new flow for approved/onboarded tenants; admins can preview by default. Legacy gates stay unchanged. Shared helper lib/require-resume-builder.ts exported requireResumeBuilder() used by actions and PDF route. Navigation passes server-resolved availability. Initial release remains disabled for ordinary users until deployment verification.

## Task 1 Data and proposals

- [x] Write failing model tests covering empty tenant content, duplicate IDs, limits, HTML escaping boundaries, stale proposal targets, exact accepted edits and source mutation isolation.
- [x] Implement shared model validation and proposal application in lib/resume-builder-model.ts.
- [x] Add migration 023 with forced tenant RLS and register new tables in lib/supabase.ts.
- [x] Implement independent documents, reviewed profile, versions, proposals and persisted render status. Use tenant-scoped transaction/CAS for acceptance and restore. Job deletion retains documents.
- [x] Implement actions above with auth first, strict inputs, billed model calls, invalid-response errors, no silent writes and safe logs.
- [x] Add isolated database integration tests for cross-tenant IDs, CAS races, duplicate accept, atomic version/proposal updates and expiration.

## Task 2 Rendering

- [x] Write failing tests for escaped malicious text, template distinction, all content retained, Letter/A4 dimensions and no truncation/shrinking.
- [x] Implement three versioned templates and same-renderer preview.
- [x] Add isolated Chromium worker with bounded timeout/concurrency, local bundled fonts, disabled network and typed result.
- [x] Generate PDFs; verify page count and geometry with realistic dense/sparse fixtures and reject overflow.
- [x] Document local/production Chromium installation; no hosted vendor or actual deployment.

## Task 3 UI

- [x] Implement /resume/builder route with page auth and capability check, library/create and document screens.
- [x] Import existing PDF/DOCX/TXT parser; show editable structured review with optional sections, field additions/removal and source text.
- [x] Add template previews, font/accent/page-size/limit controls and section order controls; preserve content on switching.
- [x] Add save/reload, proposal cards (accept/reject/revise), errors, busy states, versions, restore, delete and PDF download.
- [x] Keep dirty draft protection and disable revision-dependent operations while unsaved; responsive layout and keyboard labels.

## Task 4 Integration and verification

- [x] Connect Nav, RolesTable and legacy resume library to new flow without changing legacy access.
- [x] Add protected PDF route with tenant/capability authorization, no-store headers and attachment filename.
- [x] Run complete tests/build and focused auth, database, rendering and UI checks.
- [x] Independent review; resolve findings; verify unchanged legacy behavior and preserved unrelated files.
- [x] Commit complete implementation on the isolated branch, report tested scope and release requirements.

## Execution ledger

- Approved spec: 2fa3b64. Working directory: /private/tmp/gtm-universal-resume, branch codex/universal-resume-builder.
- Implementation starts with disjoint ownership for data/actions, renderer/worker, and builder UI; coordinator owns integration and final verification.
- Interpretation: individual AI suggestions are atomic text edits initially. User-controlled structural edits remain available in the reviewed content editor. This avoids automatic model omissions while preserving a universal content model.
- Interpretation: tenant rollout capability is disabled by default for ordinary users and enabled for admins until release verification. It does not change legacy admin-only access.
- Completed: independent content editor, three template layouts, individually reviewed proposals, immutable PDF versions, tenant/capability authorization, revision-aware PDF downloads, legacy archive links, and expiry purge integration.
- User explicitly authorized the AI data flow: source text, linked job details and edit instructions are sent to the configured provider only on Parse/Suggest clicks. No live provider calls were made during verification.
- Verification: final Next production build passed. Full suite with actual Chromium rendering passed 2,168 tests (10 skipped: opt-in real PostgreSQL tests plus existing skips). Separately, six real PostgreSQL transaction tests and three capability tests passed. Migration bootstrap succeeded against a disposable PostgreSQL 17 database.
- Browser verification used synthetic nursing career data: create, manual review/save, PDF export, individual proposal acceptance, immutable version creation/restore, DOCX/PDF text imports, disabled-account redirect, mobile width and visible preview. Proposal UI verification used a stored synthetic proposal; model integration is validated through mocked provider contracts and billing boundaries.
- Rendering verification covered all three layouts, Letter/A4, sparse one-page and dense two-page content, physical PDF dimensions, extracted text, accented glyphs, long names/URLs, overflow refusal, unavailable-browser recovery, bounded queue and child-process termination. PDFs were inspected as images. Final Linux production image built and exported an authenticated PDF as its unprivileged runtime user; this verifies packaging, not a deployed Railway release.
- Review fixes: terminate Chromium's separate process group; surface trusted renderer recovery errors; return current document on duplicate acceptance; preserve reusable profile during later tailoring; retry blocked proposals; guard unsaved browser navigation; revoke UPDATE on immutable versions; keep previous saved resumes reachable.
- Mutation checks demonstrated failures when removing HTML escaping, browser-process cleanup, duplicate-ID validation, editor revision checks, dirty-draft gating, or the post-render export revision check. All mutations restored before final validation.
- Release remains separate: apply migration 023, deploy the Docker-backed web service, verify authenticated production behavior, then intentionally enable RESUME_BUILDER_ENABLED for general users. Nothing pushed or deployed in this session. PDF is the new export format; editable DOCX export and OCR remain out of scope as specified.
