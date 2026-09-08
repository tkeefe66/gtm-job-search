-- db/migrations/019_resume_chats.sql
-- One chat thread per (tenant, job): the conversation that shaped this job's
-- tailored résumé. Working state on the DRAFT, so it is not covered by the
-- 60-day saved-résumé retention (lib/resume-retention.ts) — that window exists
-- for frozen documents in saved_resumes. It dies with the job via the cascade.
--
-- All six statements below are load-bearing. `force row level security` WITHOUT
-- `enable` only sets forcerowsecurity and is inert until rowsecurity is true,
-- so the pair ships a table with no row security at all; `enable` + `force`
-- with NO POLICY denies everything instead. Both failures are silent. This is
-- 015_tailored_resumes.sql:20-33 in full, deliberately.
--
-- tenant_id is declared INLINE, not via ALTER TABLE ... ADD COLUMN, so it is
-- invisible to lib/supabase.test.ts's retrofit regex and must be added to
-- TENANT_TABLES in lib/supabase.ts by hand.

create table if not exists resume_chats (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references users(id) on delete cascade,
  job_id     uuid not null references jobs(id) on delete cascade,
  messages   jsonb not null default '[]',
  updated_at timestamptz not null default now(),
  unique (tenant_id, job_id)
);

create index if not exists resume_chats_tenant_idx on resume_chats (tenant_id);

alter table resume_chats enable row level security;
alter table resume_chats force row level security;

drop policy if exists tenant_isolation on resume_chats;

create policy tenant_isolation on resume_chats
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

grant select, insert, update, delete on resume_chats to app_rw;
