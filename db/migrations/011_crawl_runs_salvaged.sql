-- A run whose roles came from SALVAGING a prose response carries no listing
-- evidence, and must never close a posting.
--
-- WHY THIS COLUMN EXISTS. When the model answers a search in prose instead of
-- JSON, lib/salvage-call.ts re-reads its own words under constrained decoding.
-- That recovers the answer — but if the prose was "I could not access the
-- careers page" rather than "no qualifying roles are open", the salvage
-- produces an EMPTY array. Inability and absence look identical after
-- conversion.
--
-- An empty run is trusted: LAST_TRUSTWORTHY_RUN_SQL selects
-- `status in ('ok','empty')` and closeStalePostings closes any role absent from
-- it. So without this column a formatting slip on an unreachable page closes
-- live jobs — the exact failure the salvage feature was built to avoid, moved
-- one step downstream.
--
-- Recorded on the ROW rather than expressed as a new status value because
-- "salvaged" is a provenance fact about how the answer was obtained, not a
-- workflow state — the same reasoning that kept jobs.never_live off
-- SystemStatusKey. A new CrawlStatus would also have to be threaded through
-- bucketing, the Watchlist badges, and the cron failure tallies, all of which
-- test status by equality rather than exhaustive switch, so the compiler would
-- not have caught the misses.
--
-- Ships as a migration, NOT through db/apply-schema.mjs, which would re-create
-- the insights_cache table that 006_drop_insights.sql dropped.

alter table crawl_runs
  add column if not exists salvaged boolean not null default false;

comment on column crawl_runs.salvaged is
  'True when this run''s roles were recovered from a prose response rather than parsed directly. A salvaged run that found nothing is not evidence a company lists nothing, so it is excluded from the closure-evidence query.';
