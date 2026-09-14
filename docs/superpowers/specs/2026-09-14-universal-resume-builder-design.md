# Universal resume builder

Status: product direction approved in conversation; written design awaiting review. No implementation or deployment is represented by this document.

## Decision

Create new resumes from each user's own career information. Users may import content from PDF, DOCX or TXT, paste content, or enter it directly. They choose a template and a one- or two-page limit. The app does not preserve uploaded document formatting and does not require a commercial Word/PDF editing SDK.

This supersedes the earlier bring-your-own-design investigation. Imported page count is no longer a constraint: the user chooses the new document's page limit. Individual approval of suggested changes remains mandatory. No source content, template or career vocabulary belonging to another tenant may become a fallback.

## User experience

The Resume tab opens a library with Create resume and saved documents. Creation does not require a tracked job. From a tracked role, Create tailored resume enters the same flow with the role preselected.

1. Add information. Upload PDF/DOCX/TXT, paste text, use previously reviewed career information, or fill out structured fields. Uploaded formatting is explicitly described as unused. Reuse the existing bounded text extraction path. Do not store uploaded binary files in this version.
2. Review information. Show extracted identity, contact details, roles, dates, accomplishments, education, skills and optional sections in editable fields. Model extraction is a draft. Missing or ambiguous details are highlighted; no values are invented to complete a form. Confirming the review establishes the source career record. Imported text remains available beside the extraction during review.
3. Choose a design. Preview each template with this person's information. Select a one- or two-page limit, page size, section order and supported appearance options. Choosing a design never discards content.
4. Create the base resume. The initial document uses reviewed wording. If it is over the selected page limit, keep it editable and explain the overflow. Offer individual shortening or omission proposals; do not silently truncate content.
5. Tailor if desired. Choose a tracked job or use the role selected on entry. Display each suggested wording change, omission or reorder separately, with current content, proposed content and a reason. Accept, reject or request a revision for each proposal.
6. Save and export. Preserve editable document state and immutable saved versions. Render the same template and pagination for preview and PDF. Let users restore a prior version. The save action may preserve an over-limit draft, but final PDF export is blocked until it meets the selected limit.

For text-based PDFs and DOCX, retain the current 1 MB upload bound and PDF limit of 10 source pages. These source limits are independent of the output limit. Scanned PDFs currently produce no usable text: show the existing OCR/paste recovery message instead of claiming a successful import. Automatic OCR and legacy binary .doc parsing are not added in this first design. These format boundaries must be visible before upload; product copy must say DOCX rather than imply every Word format works.

## Templates and customization

Proposed initial collection:

| Template | Structure |
| --- | --- |
| Classic | Single column, compact left-aligned header, conventional headings and typography |
| Editorial | Single column with a larger name header, stronger section hierarchy and serif typography |
| Sidebar | Narrow skills/contact column and wider experience column, with a dedicated continuation-page layout |

Retain the existing design as a compatibility template for old documents. Its career content must not be part of the template. New templates differ in layout, not just color. Template names are neutral and do not imply a particular profession or guaranteed ATS performance.

Use a small bundled font collection with verified redistribution rights. Fonts must finish loading before pagination and export. No silent font substitution. Offer bounded accent colors and font choices plus optional sections and section reordering. Template settings are explicit user actions; chat-suggested design changes still require acceptance. Do not expose unrestricted CSS, HTML or executable content.

Use US Letter portrait as the default and offer A4 portrait. The selected limit is a maximum, not a requirement to add blank pages. Default to one page and let users select two. Never silently reduce font size, margins or spacing to fit. An explicit user preference change can alter those settings within tested bounds.

## Content model

Introduce a versioned, tenant-owned ResumeProfile separate from the job-search Profile. Search criteria and search-persona text are not an authoritative employment history. Reusing onboarding text should be an explicit user choice and still requires review.

ResumeProfile contains identity, structured contact fields, summary, experience entries with stable bullet IDs, education, skills, and optional typed sections for certifications, projects, volunteering, publications and additional experience. Entries retain links to their source excerpt or user-entered origin. Empty sections are omitted. No GTM-specific required fields or shipped career/theme fallback is allowed.

ResumeDocument is an independent working document with its own ID, profile snapshot, optional job ID, selected content, template ID and version, page size, page limit, appearance preferences and monotonically increasing revision. It stores a snapshot so a later profile edit does not rewrite previously tailored resumes.

ResumeProposal identifies one document revision and target ID, operation kind, exact before and after values, reason, factual source references and state (pending, accepted, rejected, stale or blocked). A proposal changing wording after a fit failure must be presented again; accepting one wording does not authorize a different wording.

ResumeVersion is an immutable document snapshot with template version and an exportable rendering. Store enough content and design information to reproduce it without consulting today's profile. Preserve the existing expiration policy for legacy saved rows. For new documents, keep the active draft until user deletion, and use the existing 60-day window for saved snapshots with expiry displayed clearly. This is a proposed retention default, not a migration of existing records.

## Individual approval and concurrency

Chat must produce proposals rather than mutate the canonical document. All writing, omission, bullet selection and reorder operations follow this contract. Pure questions remain ordinary answers and incur no document revision.

Accept operates on a server-stored proposal ID plus expected document revision. It never trusts replacement text supplied by the browser. Authenticate and authorize first, check the target and before value, apply the exact proposed operation to a candidate, validate it, then commit document revision and proposal status atomically. A double click must be idempotent. Concurrent or stale proposals fail with an actionable message and do not overwrite newer edits.

Any accepted change invalidates remaining proposals tied to the old revision. Refresh them on demand against the new document. Rejection changes only proposal state. Request revision produces another pending proposal. Restoring a saved version creates a new working revision and invalidates outstanding proposals; it does not rewrite history.

If a proposal depends on shortening another bullet, describe that dependency. Do not bundle unrelated edits into a single approval. A candidate that exceeds the page limit remains uncommitted and offers a shorter proposal. Explicit edits to the user's source profile remain normal form saves; they do not silently propagate into existing documents.

## Rendering and export

One renderer consumes the document snapshot plus a template registry. Templates expose supported controls and rendering rules. New-document rendering is separate from the legacy frozen-HTML viewer so changes do not reinterpret old saves.

Pagination must be based on rendered geometry after fonts load, not character counts. Every block must belong to a page, with no clipping or overlap. Experience entries may split only at defined boundaries; keep headings with the following content. Sidebar continuation behavior must be designed explicitly. Export uses the same page dimensions, content and fonts.

Use a server-controlled, pinned Chromium PDF renderer in a bounded worker process for authoritative export and candidate validation. The browser may give a quick provisional fit estimate but cannot certify its own save/export. The worker renders only app-generated, sanitized document snapshots; it does not load arbitrary user URLs or uploaded HTML. Disable external requests during rendering and load trusted assets locally. Recheck revision and document hash before publishing a validation result to prevent stale-render races.

Keep draft editing responsive while validation is pending and disable acceptance/export for the affected candidate until validation completes. On a render timeout or font failure, retain the previous document and expose a retry. Heavy rendering must not run as an unbounded synchronous job in the web request handler. Implement the smallest bounded queue consistent with existing job patterns, with persisted status and idempotent completion.

Version the template assets. Previously saved documents must not pick up future stylesheet or font changes. PDF output is the primary portable export. Existing HTML downloads stay supported for legacy saves; editable DOCX export is not part of this initial version.

## Server integration and authorization

Keep model calls through lib/model-call.ts and withBudget. Resolve provider, credentials and limits from the tenant. Extracting local text does not require an AI call; structured parsing and tailoring do. Explain the billed action before starting it. Handle timeout, invalid model output, missing key and budget refusal without losing imported or edited information.

Add tenant-scoped tables for profiles, independent documents, proposals and versions, with forced RLS and matching app-level authorization. Optional job links must reference a job owned by the same tenant. Job deletion must not erase an independent resume. Apply the existing session-less server-action guard to all new action modules.

Treat upload text and job postings as untrusted model input. Validate generated data and typed operations independently of model instructions. Keep current text sanitization and no-em-dash enforcement. Errors follow presence checks, including empty database error strings. Logs contain operation IDs and state transitions, not resume contents or contact details.

Roll out through a tenant resume capability rather than granting admin status. The current admin-only renderer remains available while the new workflow is built. Enabling the capability must guard the page, navigation, actions and downloads consistently. Ordinary users gain access only after tenant-isolation and end-to-end checks pass. Deployment is a separate release step; no push or production mutation is authorized by this design document alone.

## Compatibility

Keep existing saved_resumes, tailored_resumes and resume_chats readable through their current path during rollout. Do not rewrite frozen HTML or regenerate old documents on migration. Route old IDs to the legacy viewer and new IDs to the new document flow.

The current shared career JSON and theme vocabulary may remain reachable only through the existing restricted legacy path. New tenants never receive them. Moving existing personal content into a new ResumeProfile is an explicit account-scoped import with preview; there is no global seed or administrator-role-based fallback.

Avoid changing current job-search onboarding, scoring and settings behavior as part of resume creation. The new feature may reuse upload utilities, authentication, billing and sanitization, but it must not overwrite job-search profile rows.

## Codebase anchors verified for this design

- app/resume/page.tsx currently requires admin status and chooses a saved row or a job-based draft.
- app/actions/resume.ts and app/actions/resume-chat.ts import shared career/theme JSON.
- lib/resume-upload.ts already extracts bounded PDF/DOCX/TXT text; app/actions/resume-upload.ts protects it with requireActor.
- lib/resume-render/render.d.ts currently models career content and selection around one layout with fixed advisory/education sections.
- app/actions/saved-resumes.ts stores frozen HTML plus content and requires a job for new saves.
- lib/resume-overrides.ts and lib/resume-ops.ts contain reusable typed-edit concepts, but the current chat path applies many operations immediately.
- lib/resume-download.ts currently exports standalone HTML and uses a shared design version; reliable direct PDF output is additional work, not a capability already verified here.
- lib/resume-retention.ts defines existing 60-day saved versions and shorter checkpoints.

## Verification criteria

1. Create a resume without a tracked job using manual input and imported DOCX/PDF content. Reload and verify the reviewed source, template choice and draft persist.
2. Test at least three synthetic professions with different section needs. Verify there is no cross-tenant identity, career text or theme fallback.
3. Use two tenants in action and database tests; cross-tenant document, proposal, version and job IDs must be refused. Session-less calls must throw before work begins.
4. A chat suggestion must leave document content and revision unchanged until acceptance. Exercise accept, reject, request revision, stale version, duplicate acceptance, concurrent acceptance and restore.
5. Verify a longer edit that would exceed the limit is blocked without shrinking type or dropping other content. Verify the replacement proposal is separately approved.
6. Render every template in one and two pages, Letter and A4, with long names, long URLs, accented characters, dense bullets and sparse careers. Inspect exported PDFs as images and extracted text. Assert no overlapping/clipped text, missing glyphs or extra pages.
7. Test template changes retain all content and surface overflow. Test font/render failures and worker retries without committing an invalid candidate.
8. Verify old saved rows still open and download without being rewritten. Preserve existing restore and retention tests.
9. Run npm run build and npm test before claiming implementation complete. The configured npm run lint is non-functional; use actual supported lint checks if configured at implementation time rather than reporting that script as passing.
10. Before release, verify the exact deployed commit, migrations and an authenticated synthetic create/tailor/approve/export flow. Clean up synthetic production records after verification.

## Delivery order

Deliver the profile/import and independent document foundation first, then template rendering and pagination/export, then individually approved tailoring, and finally general-user access and compatibility verification. These are implementation stages of one feature; completing the first stage is not completion of the user-facing workflow.

## Written-design review

The net-new direction, template choice and individual approvals are accepted. Concrete defaults introduced here for review are the three initial template structures, one-page default with two-page option, Letter/A4 output, text-only imports without automatic OCR, PDF-first export, and the new snapshot retention policy. No commercial editing subscription is required by this design. The next step after reviewing this document is an implementation plan grounded in these interfaces and acceptance criteria.
