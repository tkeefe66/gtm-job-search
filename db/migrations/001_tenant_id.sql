-- Tenancy, step 1: give the pipeline tables an owner.
--
-- DELIBERATELY NO RLS IN THIS MIGRATION. Policies come only after the
-- application layer is scoping every query, because enabling them first turns
-- every unscoped read into a silent empty result — the failure mode this whole
-- design is trying to avoid, introduced by the very migration meant to prevent
-- it.
--
-- ORDER IS THE POINT: add nullable -> backfill -> ASSERT -> set not null. With
-- NOT NULL first the ALTER fails on populated tables; with FORCE ROW LEVEL
-- SECURITY first (a later migration) the migration role becomes subject to its
-- own policy, the GUC is unset, the UPDATE matches zero rows, and the whole
-- thing reports success having moved nothing.

-- The owner of everything that exists today. Resolved rather than hardcoded: a
-- literal uuid would differ between this database and any restore of it.
-- Raises if the admin is missing, because backfilling to NULL and pressing on
-- would hand every existing row to nobody.
do $$
declare owner_id uuid;
begin
  select id into owner_id from users where role = 'admin' order by created_at limit 1;
  if owner_id is null then
    raise exception 'no admin user exists to own the current data — sign in once before migrating';
  end if;

  alter table jobs            add column if not exists tenant_id uuid references users(id);
  alter table watchlist       add column if not exists tenant_id uuid references users(id);
  alter table app_settings    add column if not exists tenant_id uuid references users(id);
  alter table insights_cache  add column if not exists tenant_id uuid references users(id);

  update jobs           set tenant_id = owner_id where tenant_id is null;
  update watchlist      set tenant_id = owner_id where tenant_id is null;
  update app_settings   set tenant_id = owner_id where tenant_id is null;
  update insights_cache set tenant_id = owner_id where tenant_id is null;

  -- Assert BEFORE tightening. A silent zero-row backfill is the documented
  -- failure here, and SET NOT NULL would otherwise be the thing that discovers
  -- it — by failing with a message about a constraint rather than about data.
  if exists (select 1 from jobs where tenant_id is null)
     or exists (select 1 from watchlist where tenant_id is null)
     or exists (select 1 from app_settings where tenant_id is null)
     or exists (select 1 from insights_cache where tenant_id is null) then
    raise exception 'backfill left null tenant_id rows — refusing to continue';
  end if;
end $$;

alter table jobs           alter column tenant_id set not null;
alter table watchlist      alter column tenant_id set not null;
alter table app_settings   alter column tenant_id set not null;
alter table insights_cache alter column tenant_id set not null;

-- app_settings' primary key was `key` alone, so two tenants could never hold the
-- same setting. This is the sharpest edge in the schema: it holds the fit brain,
-- the criteria and the comp floor.
--
-- NOTE for the app layer: this invalidates every `on conflict (key)` inference.
-- Postgres raises 42P10 at RUNTIME, invisible to a typecheck, so every settings
-- save would silently stop working. lib/settings-store.ts must move to
-- `on conflict (tenant_id, key)` in the same release.
alter table app_settings drop constraint if exists app_settings_pkey;
alter table app_settings add primary key (tenant_id, key);

-- Same for watchlist: unique(company) meant one tenant tracking Ramp blocked
-- everyone else from tracking it.
alter table watchlist drop constraint if exists watchlist_company_key;
create unique index if not exists watchlist_tenant_company_key
  on watchlist (tenant_id, company);

-- insights_cache is written delete-then-insert today, so a tenant can hold more
-- than one row. Collapse to the newest before making that impossible, otherwise
-- the unique index below fails on existing data.
delete from insights_cache a
 using insights_cache b
 where a.tenant_id = b.tenant_id
   and a.fetched_at < b.fetched_at;
create unique index if not exists insights_cache_tenant_key
  on insights_cache (tenant_id);

-- Every tenant-scoped read filters on tenant_id, so it leads each index.
create index if not exists jobs_tenant_idx      on jobs (tenant_id);
create index if not exists jobs_tenant_status_idx on jobs (tenant_id, status);
create index if not exists watchlist_tenant_idx on watchlist (tenant_id);
