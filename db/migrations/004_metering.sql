-- Sub-project D, step 1: metering tables and per-tenant limits.
--
-- No enforcement yet — this is the substrate. Wiring it into the Claude callers
-- is a separate change, so that a mistake here shows up as a wrong number rather
-- than as an app that refuses to search.

-- Platform-wide defaults, admin-editable. A separate table rather than a
-- tenant_id IS NULL row in app_settings: NULL comparisons inside an RLS policy
-- are a well-known way to write a policy that quietly matches nothing, or
-- everything, and platform config does not belong in a table tenant policies
-- govern.
create table if not exists platform_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
insert into platform_settings (key, value) values
  ('defaultMonthlyBudgetCents', '1000'::jsonb),
  ('defaultCrawlQuota',         '10'::jsonb)
on conflict (key) do nothing;

-- Per-tenant overrides, set at approval time. NULL means "use the platform
-- default", so raising the default lifts everyone who was never given a
-- specific number.
alter table users add column if not exists monthly_budget_cents integer;
alter table users add column if not exists crawl_quota          integer;

-- The hot path: one row per tenant per period, incremented atomically.
-- PRIMARY KEY is what makes `on conflict (tenant_id, period)` legal; without it
-- the reservation raises 42P10 at runtime on every call.
create table if not exists usage_counters (
  tenant_id   uuid not null references users(id) on delete cascade,
  period      text not null,
  spent_cents integer not null default 0,
  updated_at  timestamptz not null default now(),
  primary key (tenant_id, period)
);

-- The audit trail behind the counter. Separate because the counter must stay a
-- single row to be incremented atomically, while this is append-only detail.
--
-- `searches` is its own column and not derived from tokens: web_search calls are
-- billed per search and are NOT included in usage token counts (see
-- lib/anthropic.ts), so a cost reconstructed from tokens alone understates every
-- search-tier call — which is most of what this app spends money on.
create table if not exists usage_events (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references users(id) on delete cascade,
  occurred_at   timestamptz not null default now(),
  action        text not null,
  searches      integer not null default 0,
  input_tokens  integer not null default 0,
  output_tokens integer not null default 0,
  cost_cents    integer not null default 0,
  billed_to     text not null default 'platform'
);
create index if not exists usage_events_tenant_idx
  on usage_events (tenant_id, occurred_at desc);

-- Bring-your-own key.
--
-- key_id exists so the encryption key can ever be ROTATED: without it there is
-- no way to tell which rows use which key, and rotation becomes a flag day that
-- silently corrupts whatever it misses.
--
-- The ciphertext is bound to its tenant by AEAD additional data, so a row copied
-- into another tenant cannot be decrypted there. Without that binding, anyone
-- with a write path could bill one tenant's Anthropic account through another
-- tenant's session — no key material required.
create table if not exists tenant_api_keys (
  tenant_id        uuid primary key references users(id) on delete cascade,
  key_id           text not null,
  ciphertext       text not null,
  nonce            text not null unique,
  auth_tag         text not null,
  last_four        text not null,
  status           text not null default 'ok',
  added_at         timestamptz not null default now(),
  last_verified_at timestamptz
);

-- All three are tenant-scoped, so they get the same treatment as everything
-- else: FORCE, because plain ENABLE exempts the owner, and nullif() because a
-- committed set_config leaves the GUC as '' rather than unset on a pooled
-- connection, and ''::uuid raises.
do $$
declare t text;
begin
  foreach t in array array['usage_counters','usage_events','tenant_api_keys'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format($f$
      create policy tenant_isolation on %I
        using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
        with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    $f$, t);
  end loop;
end $$;

grant select, insert, update, delete on platform_settings to app_rw;
grant select, insert, update, delete on usage_counters   to app_rw;
grant select, insert, update, delete on usage_events     to app_rw;
grant select, insert, update, delete on tenant_api_keys  to app_rw;
