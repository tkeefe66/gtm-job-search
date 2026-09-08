-- db/migrations/021_saved_resume_content.sql
-- Makes a saved résumé REPRODUCIBLE and classifies how it was created.
--
-- `content` is the {themes, selection, overrides} that produced the row — the
-- same shape tailored_resumes.content holds. Nullable with NO default, so a row
-- written before this migration stays distinguishable from one written with an
-- empty selection; a default of '{}' would make every historical row claim to be
-- reproducible. Same reasoning as jobs.posting and saved_resumes.page_margin.
--
-- It stores the BASE selection, never the effective one. loadResumeContext
-- returns both (app/actions/resume.ts:302-312) because the merged view cannot be
-- un-merged; storing the effective selection would re-apply every override on
-- top of a selection that already has them folded in.
--
-- `kind` exists because retention now depends on the distinction (30/3 days for
-- checkpoints against 60 for deliberate saves) and the alternative — matching
-- the "Checkpoint · <date>" label — is a discriminator the user can type by
-- hand. jobs.status stores an immutable KEY with the label as presentation only,
-- for exactly this reason. The default classifies every existing row correctly
-- with no backfill.
--
-- An ALTER on an existing table inherits its RLS and its app_rw grant: migration
-- 009's column-list revoke is users-only, and a table-level grant covers columns
-- added later (012_watchlist_signal.sql and 020 both record this). So no new
-- policy and no new grant.

alter table saved_resumes add column if not exists content jsonb;
alter table saved_resumes add column if not exists kind text not null default 'save';
