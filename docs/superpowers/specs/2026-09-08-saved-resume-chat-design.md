# Editing a saved résumé: reproducible rows, checkpoint-then-restore

## Why

The résumé chat (`docs/superpowers/specs/2026-09-07-resume-chat-design.md`) lives
on the tailor screen and only there. `ChatPanel` mounts inside `TailorPanel`
(`components/resume/TailorPanel.tsx:243`), and `app/resume/page.tsx:30` renders
`TailorPanel` only when the URL carries a `jobId`. Open a saved résumé —
`/resume?savedId=…` — and there is no chat, because `savedId` wins over `jobId`
at `app/resume/page.tsx:22` and routes to `SavedResumeScreen` instead.

That is not an oversight in the routing. A saved row **cannot** be chatted at as
it stands, for two independent reasons.

**It has no selection.** `saved_resumes` (migration 016, plus `page_margin` from
020) stores `html`, `design_version`, `content_hash`, `page_margin`, and the
identity snapshot `role_title` / `company`. It does not store `{themes,
selection, overrides}`; only `tailored_resumes` does. Every chat operation is a
SELECTION operation — `set_taper`, `set_compress_after`, `set_positioning`,
`set_bullets` all re-derive the document from the career record
(`lib/resume-ops.ts:461-486`). Against a row holding only rendered HTML there is
nothing for them to operate on.

**Re-rendering one is forbidden.** The archive's whole point is that a saved row
is mounted as stored and never passed back through `renderBody`, because
re-rendering applies today's career record and today's selection rules to a
document the user committed to as final. That rule is recorded in CLAUDE.md and
in `2026-09-07-saved-resumes-design.md`, and this spec does not weaken it: no
path here ever re-renders an existing saved row. It creates new ones.

**And there is no undo, anywhere.** Verified by grep across `lib/resume-ops.ts`,
`app/actions/resume-chat.ts` and `components/resume/ChatPanel.tsx`: no undo, no
revert, no snapshot. `resume_chats` (019) stores the conversation but no per-turn
document state, and `tailored_resumes` is a bare upsert — every chat turn and
every Regenerate overwrites the one draft row for that job with no history. A
user who chats three turns and dislikes the result today has nothing to go back
to. This gap predates the current work and is the reason the first version of
this design was rejected: it proposed restoring a saved row straight into that
single draft, which would have added a second way to destroy unsaved work.

## Goals

- The chat reachable from a saved résumé, operating on that row's actual
  selection rather than on whatever the draft happens to hold.
- Editing a saved version never destroys anything, including the current draft.
- "I did XYZ and want to revert" answerable without a new history mechanism.
- Rows saved before this change degrade honestly and say what they cannot do.

## Non-goals

- **Draft branching.** One live draft per job stays the model. You can move
  between directions through the archive; you cannot hold two live drafts side
  by side and compare them. Real branching is a larger feature and nothing here
  forecloses it.
- **Re-rendering an existing saved row.** Never. The row is frozen.
- **Making hand edits re-editable.** See "What restore cannot do" below.
- **Changing retention.** Checkpoints expire at 60 days like every other saved
  row (`lib/resume-retention.ts`).

## Design

### Part 1 — Make a saved row reproducible

`db/migrations/021_saved_resume_content.sql`:

```sql
alter table saved_resumes add column if not exists content jsonb;
```

Nullable, no default, deliberately. A row written before this migration is then
DISTINGUISHABLE from one written with an empty selection — the same reason
`posting` is nullable (CLAUDE.md: "a row predating it is distinguishable from one
nothing was found for") and the same reason `page_margin` is. A default of `'{}'`
would erase that difference and make every historical row claim to be
reproducible.

An `ALTER` on an existing table inherits its RLS and its `app_rw` grant —
migration 009's column-list revoke is `users`-only and a table-level grant covers
columns added later, which `012_watchlist_signal.sql` and `020` both record. So
no new policy and no new grant.

`content` carries **the same shape as `tailored_resumes.content`**:
`{themes, selection, overrides}`. One shape, one type, nothing to drift. Two
details are load-bearing:

- It stores the **base** selection, not the effective one. `loadResumeContext`
  returns both (`app/actions/resume.ts:303-312`) precisely because the merged
  view cannot be un-merged. Storing the effective selection would re-apply every
  override on top of a selection that already has them folded in.
- `overrides` travels with it. `pageMargin` lives in `ResumeOverrides` AND in its
  own column (020, because the `<doc-page margin>` attribute sits outside the
  captured `innerHTML`). Both are written; the column stays the one the saved
  screen renders from, and the copy inside `content` is what a restore seeds the
  draft with.

`SaveResumeInput` gains `content` as a **required** field. Optional would mean a
future call site silently writes another unreproducible row, and this repo's
habit for exactly that hazard is a structural guard rather than a convention —
`INGEST_EXEMPT_COLUMNS` is the precedent. `saveResume`'s insert list and both
read queries (`app/actions/saved-resumes.ts:82`, `:121`, `:141`) gain the column;
the tenant id stays `rawQuery`'s third argument at every one, unchanged.

### Part 2 — Checkpoint, then restore

The archive is already a version history: many rows per job, each a frozen point,
bounded by retention. It simply has not been used as one, because saving is
manual and restoring would clobber. Closing both makes revert fall out with no
new table.

"Edit this version" on a saved row S does three things, in order:

1. **Checkpoint the current draft.** Render `tailored_resumes.content` through
   `renderBody` on the server and write the result as a saved row labelled
   `Checkpoint · <date>`. This is a NEW row built from a live selection, not a
   re-render of an existing saved row, so the archive's never-re-render rule is
   untouched. The existing `content_hash` duplicate check
   (`app/actions/saved-resumes.ts:57-77`) does real work here: a draft identical
   to a live saved row writes nothing, so browsing the archive does not
   accumulate junk.

   Rendering server-side rather than capturing a DOM is not a compromise here,
   because there is no DOM to capture: this runs from `/resume?savedId=…`, where
   no tailor screen is mounted. It is also complete, because a draft's hand
   edits never reach the database by typing — `tailored_resumes` holds
   `{themes, selection, overrides}` and nothing else, and `useResumeCapture`
   runs only on Save. So the server render IS the draft's full persisted state.
2. **Restore S.** Upsert S's `content` into `tailored_resumes` for that job.
3. **Navigate** to `/resume?jobId=…`, the existing tailor screen, with the chat.

Reverting is then the same button on an earlier row — the checkpoint written in
step 1, or any deliberate Save. Every state the user has had is reachable, and
the only bound is the 60-day window.

A one-level `previous jsonb` column on `tailored_resumes` was considered as a
cheaper undo and rejected: one level only, and it does nothing for "revert to
what I saved last week," which the checkpoint approach answers for free.

### Part 3 — What restore cannot do

Save captures `docPageEl.innerHTML` from the live DOM
(`components/resume/useResumeCapture.ts`), so a saved row can hold hand edits
that no selection reproduces. A restore rebuilds from the selection, so those
edits do not come back **editable**.

The row being restored keeps its own edits — it is frozen and nothing here
writes to it — so they remain viewable, printable and downloadable as a
document. Only their re-editability is gone, and the confirm says exactly that.

An earlier draft of this spec claimed the step-1 checkpoint also preserves the
CURRENT DRAFT's hand edits. That was wrong, and the correction matters because
it would have promised the user something the code cannot do. A draft's hand
edits live only in an open tailor screen's DOM and reach the database only
through Save; `tailored_resumes` never holds them. From `/resume?savedId=…`
there is no such DOM, so there are no unpersisted edits at risk and none for a
checkpoint to capture. The one residual case is a tailor screen left open in
another tab with untyped-through edits — restoring does not reach into that tab,
and its edits die on its next reload exactly as they do today (CLAUDE.md records
reload discarding them). That is a pre-existing property of the draft screen, not
something this change introduces.

The confirm states this **every time**, rather than detecting it. Re-rendering
the restored selection and comparing hashes against `content_hash` was
considered: it would also fire on `DESIGN_VERSION` drift and on sanitizer
changes, so a mismatch means "cannot reproduce this exactly" rather than "hand
edits present". Since that is the sentence being shown either way, the check buys
nothing and is not built.

### Part 4 — The affordance

One pure function, `savedEditAffordance(row)` in `lib/saved-edit-affordance.ts`,
returning a discriminated union. It is a pure function for the reason
`signInBody`, `enrichGate` and `compRescoreOffer` are: a server component's JSX
is reachable from no test in this repo, so a branch written as a ternary in the
component is green under a suite that cannot see it.

| `content` | `job_id` | result | rendered as |
|---|---|---|---|
| present | present | `restore` | **Edit this version →** |
| null | present | `draftOnly` | **Open the current draft →**, noting it may differ from this document |
| either | null | `unavailable` | no button, "the tracked role this came from was deleted" |

`draftOnly` is the honest-degradation case the user chose over hiding the button:
a row saved before this migration has no selection to restore, so the button
opens the current draft and says that it may not match what is on screen. It is
the same shape as the `unread` warning on a tailored résumé — the document is not
withheld, but it does not pretend either.

`unavailable` follows from `job_id uuid references jobs(id) on delete set null`
(migration 016): an archived résumé outlives the tracked role, which is why
`role_title` and `company` are snapshotted onto the row. With no job there is no
draft to restore into and no tailor screen to open.

## Deploy order

1. Apply `021` to production. Additive and nullable, so the running build is
   unaffected by it.
2. Deploy the code. Rows saved from that point carry `content`; earlier rows
   report `draftOnly` forever, which is correct — nothing backfills them. A
   backfill from the current draft was rejected: it would claim a document was
   built from a selection that may not have produced it.

## Testing

Pure logic, vitest, no database:

- `savedEditAffordance` — one test per row of the matrix above. The `null job_id`
  case must be asserted with `content` PRESENT as well as absent, since
  `unavailable` has to win over `restore`; a fixture that only ever pairs a null
  job with null content cannot tell the two orderings apart.
- Round-trip: what `saveResume` writes as `content` is the shape
  `loadResumeContext` reads back — a guard against the base/effective confusion
  in Part 1, which is invisible until a restored draft renders with its overrides
  applied twice.
- The checkpoint decision: a draft identical to the newest live saved row writes
  no checkpoint; a differing one does. The boundary is `content_hash` equality,
  and the test needs both sides of it, not just the differing case.
- A restore with NO draft row yet (`tailored_resumes` empty for that job — a
  résumé saved, then the draft never regenerated) writes no checkpoint and
  restores normally. Absent is not the same as identical, and the two reach the
  same "no checkpoint" outcome by different routes.

Not covered by tests, and stated so it is not mistaken for covered: the actual
upsert, the navigation, and the confirm dialog. Those are verified by using the
feature.

## Risks

- **Checkpoint noise.** Auto rows share the archive with deliberate Saves. The
  `Checkpoint · <date>` label is what keeps them distinguishable; if the list
  still reads as cluttered in use, grouping or de-emphasis in
  `lib/saved-resume-grouping.ts` is the place to fix it, not suppression of the
  checkpoint itself.
- **A revert target can age out.** Checkpoints expire at 60 days like everything
  else. This is the storage promise the app already makes rather than a new
  hazard, but a user who expects an indefinite history will be surprised.
- **`content` required is a breaking change to `SaveResumeInput`.** Intentional —
  the build is the gate that finds every call site. `npm run build` typechecks at
  ES5 and is the verification step (CLAUDE.md).
