-- The page margin is the `margin` attribute on <doc-page>
-- (components/resume/ResumeDocument.tsx:76), which lives OUTSIDE the
-- docPageEl.innerHTML that useResumeCapture serializes — so unlike the design
-- token overrides, which ride along on the .rsm root, it is not captured and
-- must be stored on the row. A margin that looks right in the draft and
-- silently reverts in the archive would only be found by comparing two screens.
--
-- An ALTER on an existing table inherits its RLS and its app_rw grant:
-- migration 009's column-list revoke is users-only, and a table-level grant
-- covers columns added later (012_watchlist_signal.sql records this). So no
-- new policy and no new grant. A null reads as the 0.68in default, which is
-- every row written before today.

alter table saved_resumes add column if not exists page_margin text;
