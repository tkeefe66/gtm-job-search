-- db/migrations/018_company_boards.sql
-- Where a company's hiring board lives, remembered.
--
-- The board tier resolves a company's board every crawl, and resolution is not
-- free in TIME even though it costs no tokens: a company that resolves to
-- nothing is up to slugs × vendors sequential fetches at an 8s timeout, on top
-- of a measured 91.2s worst-case crawl, inside a request Railway closes after
-- 300s of silence. Remembering the answer — including the answer "none" — is
-- what keeps that bounded.
--
-- Keyed on companyIdentityKey(company), NOT the raw company string, for the
-- reason lib/role-key.ts exists: "RTX (Raytheon)" and "Raytheon (RTX)" are one
-- employer, and watchlist's own (tenant_id, company) uniqueness would resolve
-- and store them twice. A separate table rather than columns on `watchlist`
-- because two of ingestRoles' three callers never touch the watchlist — Find
-- Roles and role search ingest for arbitrary companies, and they are the paths
-- that produced most of the table.
--
-- `source` is the load-bearing column: 'read' means the vendor and slug came
-- out of an employer's own posting URL, 'guessed' means they were derived from
-- the company name. lib/board-source.ts refuses to source roles from a guess
-- that no employer name corroborates, and lib/crawler.ts refuses to let one
-- close a role at all. Storing the distinction is what lets every later reader
-- keep hedging correctly.
--
-- `vendor` null with a row present is a REMEMBERED FAILURE: resolution ran and
-- found nothing. That is the whole point of writing it down — otherwise every
-- crawl re-pays the search for a company that has no board.
--
-- tenant_id is declared inline here rather than by ALTER TABLE, so it is
-- invisible to lib/supabase.ts's guard regex: this table must be added to
-- TENANT_TABLES by hand, the same note migrations 015 and 016 carry.
create table if not exists company_boards (
  tenant_id   uuid not null references users(id) on delete cascade,
  company_key text not null,
  company     text not null,
  vendor      text,
  slug        text,
  source      text,
  checked_at  timestamptz not null default now(),
  primary key (tenant_id, company_key)
);

alter table company_boards enable row level security;
alter table company_boards force row level security;

drop policy if exists tenant_isolation on company_boards;

create policy tenant_isolation on company_boards
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

grant select, insert, update, delete on company_boards to app_rw;
