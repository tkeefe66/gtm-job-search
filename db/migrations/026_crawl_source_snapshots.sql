-- Additive source proof and complete extraction snapshots. Legacy runs are not
-- retroactively promoted into evidence we did not record at the time.
alter table company_boards add column if not exists verified_at timestamptz;
alter table company_boards add column if not exists last_fetched_at timestamptz;
alter table company_boards add column if not exists careers_url text;
alter table company_boards add column if not exists evidence_url text;
alter table company_boards add column if not exists evidence_kind text;
alter table company_boards add column if not exists board_url text;

alter table crawl_runs add column if not exists closure_eligible boolean not null default false;
alter table crawl_runs add column if not exists source_key text;
alter table crawl_runs add column if not exists criteria_fingerprint text;

create table if not exists company_crawl_snapshots (
  tenant_id uuid not null references users(id) on delete cascade,
  company_key text not null,
  source_key text not null,
  criteria_fingerprint text not null,
  parser_version integer not null,
  content_fingerprint text not null,
  listings jsonb not null default '[]'::jsonb,
  processed jsonb not null default '{}'::jsonb,
  captured_at timestamptz not null,
  primary key (tenant_id, company_key, source_key, criteria_fingerprint, parser_version)
);
alter table company_crawl_snapshots enable row level security;
alter table company_crawl_snapshots force row level security;
drop policy if exists tenant_isolation on company_crawl_snapshots;
create policy tenant_isolation on company_crawl_snapshots
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update, delete on company_crawl_snapshots to app_rw;
