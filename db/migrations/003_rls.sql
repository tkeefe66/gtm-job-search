-- Tenancy, step 4: the database refuses to leak, not just the application.
--
-- Ordered LAST on purpose. Policies before the app layer scoped its queries
-- would have turned every unscoped read into a silent empty result — the exact
-- failure this design exists to prevent, delivered by the migration meant to
-- prevent it. By now every query carries a tenant and sets app.tenant_id, and
-- lib/supabase.ts asserts the GUC took effect before running anything.
--
-- This is the second belt. The application layer is still the primary control;
-- what RLS adds is that a FUTURE mistake returns nothing instead of returning
-- somebody else's rows.

-- No password and no LOGIN here: a committed migration must not carry a
-- credential. The password is set separately, out of band.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_rw') then
    create role app_rw nosuperuser nocreatedb nocreaterole noinherit nologin;
  end if;
end $$;

-- NOBYPASSRLS is the whole point: a superuser ignores policies entirely, so the
-- app connecting as one would make everything below decorative.
alter role app_rw nosuperuser nobypassrls;

grant usage on schema public to app_rw;
grant select, insert, update, delete on all tables in schema public to app_rw;
grant usage, select on all sequences in schema public to app_rw;
-- So a table added by a later migration is reachable without remembering to
-- grant it. Ownership is deliberately NOT given: a table owner can
-- ALTER TABLE ... NO FORCE ROW LEVEL SECURITY and undo this file.
alter default privileges in schema public
  grant select, insert, update, delete on tables to app_rw;

do $$
declare t text;
begin
  foreach t in array array[
    'jobs','watchlist','app_settings','insights_cache',
    'discovered_roles','discovered_startups','role_searches','crawl_runs'
  ] loop
    execute format('alter table %I enable row level security', t);
    -- FORCE, not merely ENABLE. Plain ENABLE exempts the table's OWNER, which is
    -- the role most likely to be used by a migration path — so without FORCE the
    -- policies are decorative for exactly the connection most able to do damage.
    execute format('alter table %I force row level security', t);

    execute format('drop policy if exists tenant_isolation on %I', t);
    -- nullif(...,'') is not cosmetic. After a set_config(...,true) commits on a
    -- POOLED connection the GUC reads back as the empty string rather than
    -- unset, and ''::uuid RAISES. Without the nullif, a forgotten scope fails as
    -- a hard error on a connection that has served a tenant and as an empty
    -- result on one that has not — the same bug behaving two different ways
    -- depending on which connection the pool happened to hand out.
    execute format($f$
      create policy tenant_isolation on %I
        using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
        with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    $f$, t);
  end loop;
end $$;
