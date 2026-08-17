-- Tenancy, step 2: the discovery caches belong to a tenant, not to the world.
--
-- The first design shared these, and four independent reviews found the same
-- error: they are CRITERIA-DERIVED, not world data, and their keys do not
-- contain the criteria that produced them.
--
--   role_searches is written with search_term always '' (app/actions/role-search.ts),
--     so there are exactly TWO rows platform-wide and their contents are one
--     tenant's titles x locations.
--   discovered_roles is keyed on company alone while its prompt embeds
--     titleListForPrompt(criteria) and criteria.locationRule.
--   discovered_startups injects criteria.locationRule as a ranking preference.
--   crawl_runs records role_titles produced by an extraction prompt built from
--     one tenant's title list, and closure logic reads them as evidence.
--
-- Shared, tenant B receives results computed from tenant A's criteria, sees a
-- verbatim projection of A's private settings, and — because per-tenant scoreFit
-- runs on top — gets output that LOOKS personalised. The cost saving was never
-- real: a cache whose key omits the criteria does not save money, it returns
-- wrong answers.

do $$
declare owner_id uuid;
begin
  select id into owner_id from users where role = 'admin' order by created_at limit 1;
  if owner_id is null then
    raise exception 'no admin user exists to own the current cache rows';
  end if;

  alter table discovered_roles    add column if not exists tenant_id uuid references users(id);
  alter table discovered_startups add column if not exists tenant_id uuid references users(id);
  alter table role_searches       add column if not exists tenant_id uuid references users(id);
  alter table crawl_runs          add column if not exists tenant_id uuid references users(id);

  update discovered_roles    set tenant_id = owner_id where tenant_id is null;
  update discovered_startups set tenant_id = owner_id where tenant_id is null;
  update role_searches       set tenant_id = owner_id where tenant_id is null;
  update crawl_runs          set tenant_id = owner_id where tenant_id is null;

  if exists (select 1 from discovered_roles where tenant_id is null)
     or exists (select 1 from discovered_startups where tenant_id is null)
     or exists (select 1 from role_searches where tenant_id is null)
     or exists (select 1 from crawl_runs where tenant_id is null) then
    raise exception 'backfill left null tenant_id rows — refusing to continue';
  end if;
end $$;

alter table discovered_roles    alter column tenant_id set not null;
alter table discovered_startups alter column tenant_id set not null;
alter table role_searches       alter column tenant_id set not null;
alter table crawl_runs          alter column tenant_id set not null;

-- Every cache key gains the tenant. Without this, one tenant caching a company
-- blocks every other tenant from ever caching their own view of it — and the
-- upsert would overwrite theirs.
--
-- NOTE for the app layer: each of these invalidates an `onConflict` string.
-- Postgres raises 42P10 at RUNTIME for a conflict target with no matching
-- constraint, which no typecheck sees, so every cache write would fail silently.
alter table discovered_roles drop constraint if exists discovered_roles_company_key;
create unique index if not exists discovered_roles_tenant_company_key
  on discovered_roles (tenant_id, company);

alter table discovered_startups drop constraint if exists discovered_startups_date_range_search_term_key;
create unique index if not exists discovered_startups_tenant_key
  on discovered_startups (tenant_id, date_range, search_term);

alter table role_searches drop constraint if exists role_searches_family_search_term_key;
create unique index if not exists role_searches_tenant_key
  on role_searches (tenant_id, family, search_term);

-- crawl_runs has no unique; it needs the tenant leading its lookup index, which
-- orders by (company, started_at desc).
drop index if exists crawl_runs_company_idx;
create index if not exists crawl_runs_tenant_company_idx
  on crawl_runs (tenant_id, company, started_at desc);
