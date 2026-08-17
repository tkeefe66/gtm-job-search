-- Provider routing for a tenant's stored key.
--
-- provider and model are bound into the AEAD's additional authenticated data
-- (lib/secret-box.ts) alongside tenant_id, so the routing config cannot be
-- swapped independently of the ciphertext it routes: flipping this row's
-- provider to another vendor would otherwise send this tenant's decrypted key
-- to that vendor.
--
-- aad_version exists because that binding changes the AAD of every row written
-- before it. Rows already stored were sealed against tenant_id alone; they keep
-- their version 1 and keep opening. Every new seal writes version 2.
alter table tenant_api_keys add column if not exists provider    text not null default 'anthropic';
alter table tenant_api_keys add column if not exists model       text;
alter table tenant_api_keys add column if not exists aad_version smallint not null default 1;

-- Defence in depth behind lib/providers/registry.ts: a value that cannot be
-- routed must not be storable in the first place.
alter table tenant_api_keys drop constraint if exists tenant_api_keys_provider_check;
alter table tenant_api_keys add  constraint tenant_api_keys_provider_check
  check (provider in ('anthropic', 'openai', 'google'));
