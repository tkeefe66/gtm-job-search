-- Start tracking at launch. Deliberately no UPDATE/backfill of existing jobs.
alter table jobs add column if not exists disposition text check (disposition in ('not_interested','not_a_fit','job_not_found','posting_closed','duplicate'));
alter table jobs add column if not exists disposition_reason text check (disposition_reason in ('pay','location','seniority','responsibilities','other'));
alter table jobs drop constraint if exists jobs_disposition_reason_valid;
alter table jobs add constraint jobs_disposition_reason_valid check (disposition_reason is null or (disposition is not null and disposition = 'not_a_fit'));
create table if not exists source_quality_launch (singleton boolean primary key default true check(singleton), started_at timestamptz not null default now());
insert into source_quality_launch(singleton) values(true) on conflict do nothing;
grant select on source_quality_launch to app_rw;
revoke insert,update,delete on source_quality_launch from app_rw;
create table if not exists job_source_records (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null references users(id) on delete cascade,
 job_id uuid unique references jobs(id) on delete set null,
 company text not null, role_title text not null, source_url text, source_method text,
 discovered_at timestamptz not null, cohort text not null check(cohort in ('new','legacy')),
 never_live boolean not null default false, unique(tenant_id,id)
);
create table if not exists job_disposition_events (
 id bigint generated always as identity primary key, tenant_id uuid not null references users(id) on delete cascade,
 source_record_id uuid not null, previous_status text, status text not null, disposition text, disposition_reason text,
 actor text not null check(actor in ('user','automation')), occurred_at timestamptz not null default now(),
 foreign key(tenant_id,source_record_id) references job_source_records(tenant_id,id) on delete cascade
);
create index if not exists job_disposition_latest on job_disposition_events(tenant_id,source_record_id,id desc);
alter table job_source_records enable row level security;
alter table job_source_records force row level security;
drop policy if exists tenant_isolation on job_source_records;
create policy tenant_isolation on job_source_records using(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) with check(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
alter table job_disposition_events enable row level security;
alter table job_disposition_events force row level security;
drop policy if exists tenant_isolation on job_disposition_events;
create policy tenant_isolation on job_disposition_events using(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) with check(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
grant select,insert on job_source_records,job_disposition_events to app_rw;
revoke update,delete on job_source_records,job_disposition_events from app_rw;
grant usage,select on sequence job_disposition_events_id_seq to app_rw;

create or replace function capture_job_disposition() returns trigger language plpgsql as $$
declare source_id uuid; writer text := coalesce(nullif(current_setting('app.disposition_actor',true),''),'automation');
begin
 if TG_OP='UPDATE' then
   -- Direct human status selection infers only the two familiar named outcomes.
   -- Reopening clears disposition. Explicit disposition edits keep their value.
   if NEW.status is distinct from OLD.status and NEW.disposition is not distinct from OLD.disposition
     and current_setting('app.explicit_disposition',true) is distinct from 'true' then
     NEW.disposition := case when writer='user' and NEW.status='Not Interested' then 'not_interested'
       when NEW.status='Posting Closed' then 'posting_closed' else null end;
     NEW.disposition_reason := null;
   end if;
   if (NEW.status,NEW.disposition,NEW.disposition_reason) is not distinct from (OLD.status,OLD.disposition,OLD.disposition_reason) then
     if current_setting('app.explicit_disposition',true) is distinct from 'true' or not exists (
       select 1 from job_disposition_events e where e.id=(select max(x.id) from job_disposition_events x
         join job_source_records s on s.id=x.source_record_id and s.tenant_id=x.tenant_id
         where s.job_id=NEW.id and s.tenant_id=NEW.tenant_id) and e.actor<>writer
     ) then return NEW; end if;
   end if;
 end if;
 insert into job_source_records(tenant_id,job_id,company,role_title,source_url,source_method,discovered_at,cohort,never_live)
 values(NEW.tenant_id,NEW.id,
 case when TG_OP='UPDATE' then OLD.company else NEW.company end,
 case when TG_OP='UPDATE' then OLD.role_title else NEW.role_title end,
 case when TG_OP='UPDATE' then coalesce(nullif(OLD.source_url,''),nullif(OLD.job_url,'')) else coalesce(nullif(NEW.source_url,''),nullif(NEW.job_url,'')) end,
 case when TG_OP='UPDATE' then nullif(OLD.source,'') else nullif(NEW.source,'') end,NEW.created_at,
 case when TG_OP='INSERT' then 'new' else 'legacy' end,coalesce(NEW.never_live,false)) on conflict(job_id) do nothing;
 select id into source_id from job_source_records where tenant_id=NEW.tenant_id and job_id=NEW.id;
 insert into job_disposition_events(tenant_id,source_record_id,previous_status,status,disposition,disposition_reason,actor)
 values(NEW.tenant_id,source_id,case when TG_OP='UPDATE' then OLD.status else null end,NEW.status,NEW.disposition,NEW.disposition_reason,writer);
 return NEW;
end $$;
-- AFTER INSERT sees the referenced job. BEFORE UPDATE can normalize current outcome.
drop trigger if exists job_disposition_insert on jobs;
create trigger job_disposition_insert after insert on jobs for each row execute function capture_job_disposition();
drop trigger if exists job_disposition_update on jobs;
create trigger job_disposition_update before update on jobs for each row execute function capture_job_disposition();

-- Normalize inserted current disposition before the AFTER trigger snapshots it.
create or replace function normalize_inserted_disposition() returns trigger language plpgsql as $$
begin
 if NEW.disposition is null then
   NEW.disposition := case
    when current_setting('app.disposition_actor',true)='user' and NEW.status='Not Interested' then 'not_interested'
    when NEW.status='Posting Closed' then 'posting_closed' else null end;
 end if;
 return NEW;
end $$;
drop trigger if exists job_disposition_normalize_insert on jobs;
create trigger job_disposition_normalize_insert before insert on jobs for each row execute function normalize_inserted_disposition();
