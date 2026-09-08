# Editing a saved résumé: reproducible rows, checkpoint-then-restore

**Revision 2**, after two independent reviews of revision 1. Revision 1 was
wrong in four ways that would have shipped as data loss or as a document the
user never had; the corrections are recorded inline at each point rather than
in a trailing section, because each one changes the design rather than only its
prose. What survived unchanged: the `content jsonb` column, the
checkpoint-then-restore shape, and the affordance matrix.

## Why

The résumé chat (`docs/superpowers/specs/2026-09-07-resume-chat-design.md`)
lives on the tailor screen and only there. `ChatPanel` mounts inside
`TailorPanel` (`components/resume/TailorPanel.tsx:243`), and `app/resume/page.tsx`
renders `TailorPanel` (`:94`) only when the URL carries a `jobId` — `savedId`
wins at `:23` and routes to `SavedResumePanel` instead. Open a saved résumé and
there is no chat.

That is not an oversight in the routing. A saved row **cannot** be chatted at as
it stands, for two independent reasons.

**It has no selection.** `saved_resumes` (migration 016, plus `page_margin` from
020) stores `html`, `design_version`, `content_hash`, `page_margin`, and the
identity snapshot `role_title` / `company`. It does not store `{themes,
selection, overrides}`; only `tailored_resumes` does. The chat's operations are
selection operations — `set_taper` (`lib/resume-ops.ts:461`), `set_compress_after`
(`:480`), `set_positioning` (`:454`), `add_bullet` (`:407`), `drop_bullet`
(`:416`), `swap_bullet` (`:424`) — every one writes into a `ResumeOverrides`
draft that `effectiveDocument` (`lib/effective-document.ts:19-45`) later folds
into a document. Against a row holding only rendered HTML there is nothing for
them to write into.

> Revision 1 named a `set_bullets` operation that does not exist, and said these
> ops "re-derive the document," which `effectiveDocument` does, not they. The
> load-bearing point is unchanged.

**Re-rendering a saved row is forbidden.** The archive's point is that a saved
row is mounted as stored and never passed back through `renderBody`, because
re-rendering applies today's career record and today's selection rules to a
document the user committed to as final. Nothing in this spec re-renders an
existing saved row. It creates new ones — but see "Restore is itself a
re-render" below, which revision 1 missed entirely.

**And there is no undo, anywhere.** Verified across `lib/resume-ops.ts`,
`app/actions/resume-chat.ts` and `components/resume/ChatPanel.tsx`: no undo, no
revert, no snapshot. `resume_chats` (019) stores the conversation but no
per-turn document state, and `tailored_resumes` is a bare upsert — every chat
turn (`resume-chat.ts:567`, `:778`) and every Regenerate (`resume.ts:234`)
overwrites the one draft row with no history. A user who chats three turns and
dislikes the result has nothing to go back to. This gap predates the feature and
is why revision 1's first shape — restore straight into that single draft — was
rejected.

## Goals

- The chat reachable from a saved résumé, operating on that row's own selection.
- Editing a saved version never destroys anything.
- "I did XYZ and want to revert" answerable without a new history mechanism.
- Rows saved before this change degrade honestly and say what they cannot do.

## Non-goals

- **Draft branching.** One live draft per job. You can move between directions
  through the archive; you cannot hold two live drafts side by side.
- **Re-rendering an existing saved row.** Never.
- **Making hand edits re-editable.**
- **Optimistic concurrency on `tailored_resumes`.** See Risks.

## Design

### Part 1 — Make a saved row reproducible

`db/migrations/021_saved_resume_content.sql`:

```sql
alter table saved_resumes add column if not exists content jsonb;
alter table saved_resumes add column if not exists kind text not null default 'save';
```

Nullable, no default, deliberately: a row written before this migration stays
DISTINGUISHABLE from one written with an empty selection, the same reason
`posting` and `page_margin` are nullable. A default of `'{}'` would make every
historical row claim to be reproducible.

`kind` is `'save'` or `'checkpoint'`, defaulting to `'save'` so every existing
row is correctly classified as deliberate without a backfill. It exists because
retention now depends on the distinction (Part 5) and the alternative — matching
the `Checkpoint · <date>` label — would be a stringly-typed discriminator the
user can type by hand. This repo already learned that once: `jobs.status` stores
an immutable KEY and the label is presentation only, precisely so a rename
rewrites no rows. Same rule here.

An `ALTER` inherits the table's RLS and its `app_rw` grant — migration 009's
column-list revoke is `users`-only and a table-level grant covers columns added
later, recorded in `012_watchlist_signal.sql` and in `020`. No new policy, no new
grant.

`content` carries `{themes, selection, overrides}`, matching what
`tailored_resumes.content` holds today (`resume-chat.ts:568`, `:779`). Note this
is a MAXIMUM shape, not an invariant: Regenerate writes only `{themes, selection}`
(`resume.ts:234`), so a freshly regenerated draft has no `overrides` key and
readers must default it to `{}`. (CLAUDE.md and migration 016 both still describe
`tailored_resumes.content` as `{themes, selection}`; that is stale and worth a
separate correction.)

It stores the **base** selection, never the effective one. `loadResumeContext`
returns both (`app/actions/resume.ts:302-312`) precisely because the merged view
cannot be un-merged; storing the effective selection would re-apply every
override on top of a selection that already has them folded in.

#### `content` is not a client input

> **Revision 1 was wrong here, and the error was self-concealing.** It made
> `content` a required field on `SaveResumeInput` — an input populated by the
> client. But `app/resume/page.tsx:96` passes `initialSelection={resumeContext.selection}`,
> the EFFECTIVE selection, and discards `baseSelection`; `TailorPanel`'s state is
> then updated from `sendChatTurn`'s `doc.selection`, also effective. So the
> natural implementation would have written effective-selection-plus-overrides —
> exactly the double-apply corruption the spec's own round-trip test existed to
> catch. That test could not have caught it: it asserts on `saveResume`'s inputs,
> and the wrong value is supplied upstream in a component, and `components/**` is
> outside vitest's include list.

`content` is therefore read **server-side**, never accepted from the caller.
Two entry points, because the two Save buttons mean genuinely different things
and revision 1 conflated them:

- **`saveResumeFromDraft({ jobId, html, pageMargin, label? })`** — the tailor
  screen's Save (`TailorPanel.tsx:106`). Reads `tailored_resumes` for that job
  inside the action and stores what it finds as `content`.
- **`saveResumeAsNewVersion({ fromSavedId, html, pageMargin, label? })`** — the
  archive screen's "Save as new version" (`SavedResumePanel.tsx:48`). Copies the
  SOURCE row's `content` forward, which is `null` for a pre-021 row. It must not
  reach for the draft: that button captures the frozen row's DOM, so attaching
  the draft's selection would produce a row whose `html` and `content` describe
  different documents with nothing recording which is authoritative.

Both funnel into one private insert. Splitting the action is what makes the build
find every call site with a correct answer available at each — which the
"required field" approach could not do, since `SavedResumePanel` has no selection
to pass. Revision 1 cited `INGEST_EXEMPT_COLUMNS` as precedent for that required
field; the analogy was wrong. `INGEST_EXEMPT_COLUMNS` is a RUNTIME structural
guard with a test that captures `addJob`'s real argument
(`lib/ingest-roles.test.ts:436-458`), not a compile-time signature.

A pre-existing bug this flow inherits: `saveAsNew` passes
`jobId: resume.jobId as string`, which is `null` for an orphaned row, and
`saved-resumes.ts:63`'s `job_id = $2` never matches under SQL null semantics — so
the duplicate check is silently inert for those rows. Out of scope to fix here,
recorded so it is not mistaken for something this change introduced.

#### Read paths

`getSavedResume` (`saved-resumes.ts:141`) selects `content`.

`listSavedResumes` (`:121`) selects **`content is not null as has_content`**, not
`content`.

> Revision 1 said both queries "gain the column." That would have shipped every
> document's full selection, `overrides.text` (arbitrary rewritten bullet text)
> and `overrides.design` for every live row in the tenant on one page load —
> the same mistake `lib/types.ts` already documents having avoided for `html`
> ("at up to 512 KB per row it would make the archive list ship every document
> in the tenant"). The affordance needs a boolean, so the query returns a
> boolean.

### Part 2 — Checkpoint, then restore

The archive is already a version history: many rows per job, each frozen,
bounded by retention. It has not been used as one because saving is manual and
restoring would clobber. Closing both makes revert fall out with no new table.

**One action, `restoreSavedVersion(savedId)`**, taking `savedId` and nothing
else. It reads the saved row tenant-scoped and derives `job_id` from it.

> Revision 1 left the input unstated. If the button passed `jobId` — it is in the
> URL and in client state — an arbitrary `jobId` would reach the
> `tailored_resumes` upsert. RLS checks `tenant_id`, and the FK to `jobs`
> bypasses row security by design (migration 016's own comment says so), so a
> caller could create a row in their own tenant keyed to another tenant's job.
> No cross-tenant read, but a write keyed by an unowned identifier, and trivially
> avoided.

The action, in order, aborting on any failure:

**1. Render the current draft.** The full pipeline, named explicitly because
"render `content` through `renderBody`" is ambiguous and revision 1's reading of
it was wrong:

```
readAllSettingsResult → careerOverlayFrom → effectiveCareer(career, overlay, overrides.text)
  → effectiveDocument(...) → renderBody(doc.career, doc.selection, { rootStyle: styleAttributeFor(overrides.design) })
```

plus `overrides.pageMargin` carried into the insert the way `TailorPanel:112`
does. This is `loadResumeContext` and `ResumeDocument` combined.

> Revision 1 said "render `tailored_resumes.content` through `renderBody`", which
> read literally means `renderBody(shippedCareer, content.selection)` — silently
> dropping overlay bullets, text overrides, `compressAfter` (applied onto
> `career.rules`, not passed as a render option), taper, lead, and the
> design-token `rootStyle`. The checkpoint would have been a document the user
> never had, while the spec claimed it "IS the draft's full persisted state."

Rendering server-side rather than capturing a DOM is correct here, not a
compromise: this runs from `/resume?savedId=…` where no tailor screen is
mounted, and a draft's hand edits never reach the database by typing —
`tailored_resumes` holds `{themes, selection, overrides}` and nothing else, and
`useResumeCapture` runs only on Save (its only two call sites are the two Save
handlers, `TailorPanel.tsx:105` and `SavedResumePanel.tsx:43`).

**2. Write the checkpoint**, labelled `Checkpoint · <date>`, with
`role_title` / `company` taken from **the saved row S's own snapshot**. Those
columns are `NOT NULL`, and no job read has happened on this screen; borrowing
S's identity is correct only because the checkpoint and S share a `job_id`, which
is why the action derives `job_id` from S rather than accepting it.

**Suppression rule.** Skip the checkpoint only when the draft's `content` equals
the newest live saved row's `content`, and never when that row's `content` is
null.

> Revision 1 said the existing `content_hash` check would suppress duplicates.
> That is a hash of HTML, and it opens a data-loss path: if the newest live row R
> predates 021 (or came from `saveAsNew`, or carries hand edits) and the rendered
> draft happens to hash-match R, no checkpoint is written, the restore overwrites
> `tailored_resumes`, and the draft's selection now exists nowhere — R has
> `content = null`, so R itself reports `draftOnly`. HTML equality also does not
> imply selection equality: `page_margin` lives OUTSIDE `docPageEl.innerHTML`
> (migration 020's entire reason), so a draft differing only in
> `overrides.pageMargin` hashes identically and would lose the margin. Comparing
> `content` rather than `html` fixes both. Revision 1's assertion that "every
> state the user has had is reachable" was false as written.

**3. Restore.** Upsert S's `content` into `tailored_resumes`. Proceeds **only**
if step 2 returned `{id}` or `{duplicateOf}`; any `{error}` aborts and reports,
writing nothing. `sanitizeResumeHtml` can legitimately refuse the render
(`MAX_HTML_BYTES` 512 KB, the `.rsm` root check) and the insert can fail like any
write — revision 1 described the steps as ordered but not as conditional, which
would destroy the draft with no checkpoint.

**4. Append a marker turn to `resume_chats`** recording the restore, then
navigate.

> Revision 1 ignored `resume_chats` entirely, and this is the gap most likely to
> produce confusing behaviour on day one, given the feature exists to put the
> chat in front of saved rows. The thread is per `(tenant, job)` and
> `sendChatTurn` passes the FULL prior thread into `buildChatPrompt`
> (`resume-chat.ts:363`). After restoring V1 the thread still holds the turns
> that produced V2, so the model is told it already made changes the restored
> document does not contain. Worse, `acceptProposedBullets`
> (`resume-chat.ts:712-718`) resolves ids against every proposal the thread has
> ever carried, so a proposal from the discarded direction stays accept-able
> against the restored draft. A marker turn is the cheapest honest fix: the
> thread stays a continuous log, and the model is told the base changed. Clearing
> the thread was considered and rejected — it destroys the reasoning that
> produced both versions, which is the thing the user is moving between.

### Part 3 — Restore is itself a re-render, and the confirm must say so

Restoring rebuilds from `content.selection` against **today's** career record,
today's overlay, and today's `DESIGN_VERSION`. That is the same operation the
archive forbids for saved rows, applied legitimately to a new draft rather than
to a frozen row — but the user-visible consequence is real and revision 1's
confirm text mentioned only hand edits.

Concretely: `render.js` resolves each selected id against the role's bullets and
drops unknown ids silently, and **drops the whole role when nothing survives**.
Delete an overlay bullet (`propose_career_bullet` / `acceptProposedBullets` write
them, and nothing prevents their later removal), restore a version that selected
it, and a role can vanish with no message.

So the confirm states two things, every time, rather than detecting either:

1. This rebuilds the document from its selection against the current career
   record, and may differ from what you saved.
2. Hand edits in the saved version do not come back editable. The row itself is
   frozen and untouched, so they remain viewable, printable and downloadable.

Detection was considered — re-render the restored selection and compare against
`content_hash` — and rejected: it also fires on `DESIGN_VERSION` drift and
sanitizer changes, so a mismatch means "cannot reproduce this exactly," which is
the sentence being shown either way.

> Revision 1 also claimed the step-2 checkpoint preserves the CURRENT DRAFT's
> hand edits. It cannot: a draft's hand edits live only in an open tailor DOM.
> The residual case is a tailor screen open in another tab, whose edits die on
> its next reload exactly as they do today. Separately, the saved screen mounts
> its frozen HTML `contentEditable` (`SavedResumePanel.tsx:158-163`), so clicking
> "Edit this version" navigates away and discards uncaptured edits made THERE —
> the confirm should mention it if any are pending.

`design_version` is not part of `content` and is not restored. The checkpoint
stamps the current `DESIGN_VERSION`, correctly, since it is a fresh render. A
restored draft therefore carries no "saved against an earlier document design"
notice — that string exists only in `SavedResumePanel`. Known gap, not fixed
here.

### Part 4 — The affordance

One pure function, `savedEditAffordance({ hasContent, jobId })` in
`lib/saved-edit-affordance.ts`, returning a discriminated union — pure for the
reason `signInBody` (`lib/auth-policy.ts:246`), `enrichGate`
(`lib/enrich-scope.ts:89`) and `compRescoreOffer` (`lib/rescore-progress.ts:123`)
are: a server component's JSX is reachable from no test in this repo, so a branch
written as a ternary is green under a suite that cannot see it.

| `hasContent` | `job_id` | result | rendered as |
|---|---|---|---|
| true | present | `restore` | **Edit this version →** |
| false | present | `draftOnly` | **Open the current draft →**, noting it may differ |
| either | null | `unavailable` | no button, "the tracked role this came from was deleted" |

`draftOnly` navigates only. It writes no checkpoint and restores nothing, so it
is safe — worth stating, because an implementer could reasonably route it through
`restoreSavedVersion` and write a pointless row.

`unavailable` follows from `job_id ... on delete set null` (016): an archived
résumé outlives its role. For such a row the whole chat feature is permanently
unreachable, not merely the button — `tailored_resumes.job_id` and
`resume_chats.job_id` are both `NOT NULL`, so neither row can exist.

### Part 5 — Tiered retention

Revision 2 left this unresolved and blocking, because restoring put an
indefinitely-held draft onto a 60-day clock. Resolved as three tiers:

| row | retention |
|---|---|
| deliberate Save (`kind = 'save'`), **all of them** | 60 days |
| newest checkpoint for a job | 30 days |
| superseded checkpoints | 3 days |
| the live `tailored_resumes` row | never expires |

The last line is not a tier and must not become one: that row is the document
being edited, not a snapshot of one.

Every deliberate Save keeps its full 60 days however many there are. Decaying
older ones was considered and rejected — a version the user consciously chose to
keep would disappear because they saved a newer one, and the archive would stop
being an archive.

**The predicates do not change.** `EXPIRED_PREDICATE` and `LIVE_PREDICATE`
(`lib/resume-retention.ts`) compare `expires_at` against `now()` and nothing
else; only the STAMPING learns tiers. That keeps the one-home rule and the
complementary-pair test intact, which matters because CLAUDE.md records this
exact comparison as a live two-places hazard. `RETENTION_DAYS = 60` stays;
`CHECKPOINT_RETENTION_DAYS = 30` and `SUPERSEDED_CHECKPOINT_DAYS = 3` join it in
the same module, and `expiresAtFrom` takes the day count rather than three
functions diverging.

**Demotion.** "Newest" is a moving target, so writing a checkpoint demotes the
previous newest checkpoint for that job:

```sql
update saved_resumes set expires_at = least(expires_at, now() + interval '3 days')
where tenant_id = $1 and job_id = $2 and kind = 'checkpoint' and id <> $3
```

`least()` is load-bearing: stamping `now() + 3 days` unconditionally would
EXTEND a checkpoint already 29 days old, quietly lengthening retention instead of
shortening it. The demotion runs over every older checkpoint rather than only the
one previously newest, so a row missed by an interrupted earlier write cannot
linger at 30 days forever.

**Visibility.** Saved cards already render "expires in N days" from `expires_at`.
Checkpoint cards show the same line, so a 3-day row reads as urgent rather than
disappearing silently. `listSavedResumes` therefore also selects `kind`, which is
a short string and does not carry the payload problem `content` does.

**What this narrows.** The promise is no longer "every state you have had is
reachable." It is: the state before your most recent restore for 30 days,
anything earlier for 3. Browse two saved versions in one sitting and the first
checkpoint is immediately on the 3-day clock. Accepted deliberately — a
checkpoint's real job is "undo what I just did" — but it is narrower than
revision 2 claimed, and the earlier sentence in Part 2 is corrected accordingly.

## Deploy order

1. Apply `021`. Additive and nullable; the running build is unaffected.
2. Deploy the code. Rows saved from that point carry `content`; earlier rows
   report `draftOnly` forever. Nothing backfills them — a backfill from the
   current draft would claim a document was built from a selection that may not
   have produced it.

## Testing

Pure logic, vitest, no database:

- `savedEditAffordance` — one test per row of the matrix. The null-`job_id` case
  must be asserted with `hasContent` TRUE as well as false, since `unavailable`
  has to win over `restore`; a fixture pairing a null job only with absent
  content cannot tell the two orderings apart.
- **The checkpoint render pipeline** — render a known `content` through the
  checkpoint path and assert byte-equality against
  `renderBody(effectiveDocument(...), { rootStyle })`. This is the test that
  bites on revision 1's two worst errors at once: the dropped overrides, and the
  base-vs-effective confusion. Without it both are invisible until a restored
  draft renders wrong.
- The suppression rule: a draft whose `content` equals the newest live row's
  writes no checkpoint; one that differs writes one; and a newest row with
  `content = null` **always** writes one. Three cases, because the third is the
  data-loss path and is not implied by the first two.
- A restore with no `tailored_resumes` row yet writes no checkpoint and restores
  normally. Absent is not identical, and the two reach the same outcome by
  different routes.
- Retention tiers: a deliberate Save stamps 60 days, a checkpoint 30. Demotion
  moves an older checkpoint to 3 days but **never extends one** — assert against
  a checkpoint whose `expires_at` is already inside 3 days, which is the case
  `least()` exists for and the one a naive `now() + 3 days` passes silently.
  Assert too that demotion leaves `kind = 'save'` rows untouched: a fixture with
  only checkpoints in it cannot tell a correct `kind` filter from a missing one.

Not covered, stated so it is not mistaken for covered: the upsert, the
navigation, the confirm dialog, and the marker turn's effect on model behaviour.

## Risks

- **Restoring puts an indefinitely-held draft on a clock.** `tailored_resumes`
  has no expiry; a checkpoint does. Revision 1 called this "the storage promise
  the app already makes rather than a new hazard," which was wrong. **Resolved by
  Part 5**, which makes the clock explicit and visible rather than removing it:
  30 days for the state before your most recent restore, 3 for anything earlier.
  The residual risk is that 3 days is short if a user restores repeatedly while
  exploring, then wants the state from the start of the session.
- **No optimistic concurrency.** `sendChatTurn` reads context, calls the model for
  seconds, then upserts unconditionally. A restore landing mid-flight is
  overwritten with no conflict and no message: the user arrives at the tailor
  screen showing the old draft plus one chat op, with a checkpoint row implying a
  restore that did not survive. Double-clicking "Edit this version" likewise
  writes a checkpoint of the just-restored content. Accepted limitation unless a
  `generated_at` guard is added to the restore upsert.
- **Checkpoint noise.** Auto rows share the archive with deliberate Saves; the
  label is what distinguishes them. There is no cap on saved rows per job and each
  carries a full HTML document. If it reads cluttered,
  `lib/saved-resume-grouping.ts` is where to fix it.
- **Two cards, one document.** After a restore the archive shows both the
  checkpoint and S, and the draft is a copy of S. "One live draft per job" holds
  mechanically but is not what the user sees.
