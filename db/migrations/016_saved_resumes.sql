-- db/migrations/016_saved_resumes.sql
-- The résumé ARCHIVE: one row per explicit save, many per job. Distinct from
-- tailored_resumes, which stays the working draft (one per job, upserted by
-- Regenerate, holding {themes, selection}). Two tables because they have
-- different lifetimes and only one expires.
--
-- job_id KEEPS its foreign key, as ON DELETE SET NULL. An earlier design
-- dropped it, reasoning that a referential action against a FORCE RLS table was
-- unsafe to assume — this repo already disproves that: tailored_resumes is
-- force row level security (015:24-25) with job_id ... on delete cascade
-- (015:15), and app/actions/jobs.ts:89 genuinely deletes jobs. Postgres
-- documents RI checks as always bypassing row security. Keeping the FK also
-- makes "is this job gone?" the column `job_id is null` rather than a probe
-- against jobs for every card rendered.
--
-- Same explicit grant as 004 and 015: this is a new table with tenant_id
-- declared inline, so it also needs a manual addition to TENANT_TABLES in
-- lib/supabase.ts (the guard test's regex only sees ALTER TABLE retrofits).

create table if not exists saved_resumes (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references users(id) on delete cascade,
  job_id         uuid references jobs(id) on delete set null,
  role_title     text not null,
  company        text not null,
  label          text,
  html           text not null,
  design_version text not null,
  content_hash   text not null,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null
);

-- Both indexes lead with tenant_id because EVERY query against this table is
-- tenant-scoped, the purge included.
create index if not exists saved_resumes_tenant_created_idx
  on saved_resumes (tenant_id, created_at desc);
create index if not exists saved_resumes_tenant_expires_idx
  on saved_resumes (tenant_id, expires_at);

alter table saved_resumes enable row level security;
alter table saved_resumes force row level security;

drop policy if exists tenant_isolation on saved_resumes;

create policy tenant_isolation on saved_resumes
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

grant select, insert, update, delete on saved_resumes to app_rw;
