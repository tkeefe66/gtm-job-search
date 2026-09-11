-- Existing missing grades enter the queue; existing grades are never overwritten.
alter table jobs add column if not exists grading_state text not null default 'pending';
alter table jobs add column if not exists grading_attempts integer not null default 0;
alter table jobs add column if not exists grading_next_at timestamptz;
alter table jobs add column if not exists grading_error text;
alter table jobs add column if not exists grading_lease uuid;
alter table jobs add column if not exists grading_chosen boolean not null default false;
update jobs set grading_chosen=true where source='Added by URL';
create index if not exists jobs_missing_grades on jobs (tenant_id, grading_next_at, created_at)
  where fit_score is null and never_live = false;
