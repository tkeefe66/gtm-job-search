-- Sub-project D: the default ceilings, and the decision that there is no
-- unmetered admin.
--
-- TWO WINDOWS. The risk a cap protects against is a BURST — a retry loop, a bad
-- deploy, an uncapped max_uses issuing forty searches where six were expected.
-- A monthly ceiling fits that badly: set low it locks the owner out for weeks,
-- set high enough not to, it never fires. The daily ceiling contains a burst to
-- one day and heals at midnight; the monthly one is the outer bound.
--
-- ADMIN IS METERED, with bigger numbers and the sole ability to raise its own
-- ceiling from /admin. An exempt owner never exercises the metering path, so the
-- first real test of the ceiling would be a stranger hitting it.
--
-- Sized against a real run: an uncapped By Role run is ~$1.13 (lib/cost-estimate.ts).
-- Free gets roughly one such run a day and nine a month; admin roughly nine a day.
insert into platform_settings (key, value) values
  ('defaultDailyBudgetCents',   '200'::jsonb),    -- $2/day  for a free account
  ('defaultMonthlyBudgetCents', '1000'::jsonb),   -- $10/month
  ('adminDailyBudgetCents',     '1000'::jsonb),   -- $10/day for the owner
  ('adminMonthlyBudgetCents',   '10000'::jsonb)   -- $100/month
on conflict (key) do update set value = excluded.value, updated_at = now();

-- Per-tenant daily override, alongside the monthly one added in 004. NULL means
-- "use the platform default", so raising a default lifts everyone who was never
-- given a specific number.
alter table users add column if not exists daily_budget_cents integer;
