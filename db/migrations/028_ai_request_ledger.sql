create table if not exists ai_operations (
  id uuid not null,
  tenant_id uuid not null references users(id) on delete cascade,
  action text not null,
  workload text not null check (workload in ('foreground','background')),
  provider text not null,
  model text not null,
  billed_to text not null default 'tenant' check (billed_to in ('platform','tenant')),
  company text,
  crawl_run_id uuid,
  job_id uuid,
  trigger text,
  started_at timestamptz not null,
  finished_at timestamptz,
  last_activity_at timestamptz not null,
  settled_at timestamptz,
  status text not null default 'running' check (status in ('running','recovering','complete','unknown')),
  reserved_cents integer not null default 0 check (reserved_cents >= 0),
  accounted_cents integer not null default 0 check (accounted_cents >= 0),
  known_cost_microusd bigint not null default 0 check (known_cost_microusd >= 0),
  cost_complete boolean not null default false,
  result_status text,
  new_roles integer,
  primary key (tenant_id,id)
);
create table if not exists ai_usage_requests (
  id uuid not null,
  tenant_id uuid not null,
  operation_id uuid not null,
  company text,
  crawl_run_id uuid,
  job_id uuid,
  trigger text,
  phase text,
  provider text not null,
  model text not null,
  kind text not null check (kind in ('complete','search')),
  max_tokens integer not null,
  max_searches integer,
  search_mode text,
  state text not null default 'in_flight' check (state in ('in_flight','known','unknown')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  provider_request_id text,
  provider_response_id text,
  stop_reason text,
  usage_source text,
  usage jsonb,
  pricing_snapshot jsonb,
  cost_microusd bigint check (cost_microusd >= 0),
  error_kind text,
  primary key (tenant_id,id),
  foreign key (tenant_id,operation_id) references ai_operations(tenant_id,id) on delete cascade,
  check ((state = 'known' and cost_microusd is not null and usage is not null) or (state <> 'known' and cost_microusd is null))
);
create index if not exists ai_requests_company_idx on ai_usage_requests(tenant_id,company,started_at desc);
create index if not exists ai_operations_pending_idx on ai_operations(tenant_id,started_at) where settled_at is null;
alter table usage_events add column if not exists workload text;
alter table usage_events add column if not exists operation_id uuid;
alter table usage_events add column if not exists cost_complete boolean;
alter table usage_events add column if not exists cost_microusd bigint;
alter table usage_events add column if not exists held_cents integer not null default 0;
create unique index if not exists usage_events_operation_idx on usage_events(tenant_id,operation_id) where operation_id is not null;
do $$ declare t text; begin
  foreach t in array array['ai_operations','ai_usage_requests'] loop
    execute format('alter table %I enable row level security',t);
    execute format('alter table %I force row level security',t);
    execute format('drop policy if exists tenant_isolation on %I',t);
    execute format($f$create policy tenant_isolation on %I
      using (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
      with check (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)$f$,t);
    execute format('grant select,insert,update,delete on %I to app_rw',t);
  end loop;
end $$;
