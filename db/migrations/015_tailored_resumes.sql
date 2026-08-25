-- db/migrations/015_tailored_resumes.sql
-- One row per (tenant, job): the themes derived for that job and the bullet
-- selection produced from them. Regenerating overwrites via the unique
-- constraint's upsert target — see app/actions/resume.ts.
--
-- New table with tenant_id declared inline (not an ALTER TABLE retrofit),
-- so it needs the same explicit grant 004_metering.sql uses (003_rls.sql's
-- default-privileges clause is not relied on alone) and a manual addition
-- to TENANT_TABLES in lib/supabase.ts (see that file's comment on why the
-- guard test's regex can't catch this pattern).

create table if not exists tailored_resumes (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references users(id) on delete cascade,
  job_id       uuid not null references jobs(id) on delete cascade,
  content      jsonb not null,
  generated_at timestamptz not null default now(),
  unique (tenant_id, job_id)
);

create index if not exists tailored_resumes_tenant_idx
  on tailored_resumes (tenant_id);

alter table tailored_resumes enable row level security;
alter table tailored_resumes force row level security;

drop policy if exists tenant_isolation on tailored_resumes;

create policy tenant_isolation on tailored_resumes
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

grant select, insert, update, delete on tailored_resumes to app_rw;
