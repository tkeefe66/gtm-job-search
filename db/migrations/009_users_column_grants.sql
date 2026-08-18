-- The app role may write every column of `users` EXCEPT the one that grants
-- admin.
--
-- WHY THIS IS NOT COVERED BY WHAT CAME BEFORE. `users` is auth schema: it has no
-- tenant_id, no RLS policy, and migration 003's blanket
-- `grant select, insert, update, delete on all tables in schema public to app_rw`
-- therefore covers `role` like any other column. Nothing in the app writes it
-- outside the two paths listed below, but that is a property of today's code,
-- enforced by nothing — any future mass-assigning update, or a bug in signup or
-- profile-edit that reaches this table, is a privilege-escalation path to
-- `role = 'admin'`, which is the flag /admin and every requireAdmin() check read.
--
-- THE INTUITIVE FIX IS A SILENT NO-OP. This does nothing at all:
--
--     revoke update (role) on users from app_rw;   -- ← no-op under a table grant
--
-- Postgres column privileges are ADDITIVE to table privileges, never
-- subtractive: a column-level revoke can only remove a column-level grant, and
-- cannot punch a hole in a table-level one. With the blanket grant in place the
-- table ACL still reads app_rw=arw, the column's attacl stays NULL, and
-- has_column_privilege(...,'UPDATE') still returns true — so the UPDATE succeeds
-- while the migration reads as though it closed the path. The working form is to
-- revoke at TABLE level first, then re-grant the columns the app legitimately
-- writes.
--
-- MAINTENANCE COST, stated because it surprises people: app_rw now holds an
-- explicit column list, so EVERY column added to `users` later needs its own
-- `grant update (col) on users to app_rw` (or `grant insert (col)`). A forgotten
-- one fails loudly at runtime — the right direction to fail, but it is a real
-- cost. `crawl_quota` is deliberately absent from both lists: nothing writes it
-- today, and a future writer should fail loudly rather than inherit access.
--
-- ORDER ALSO MATTERS: a later migration repeating 003's blanket
-- `grant ... on all tables in schema public` re-opens this. Migration 003 is
-- already recorded in schema_migrations and the runner is forward-only, so it
-- will not re-run — but a hand-run of that line would undo this file.

-- ---------------------------------------------------------------------------
-- UPDATE. Every writer of this table, enumerated:
--   @auth/pg-adapter updateUser  -> name, email, "emailVerified", image
--   auth.ts linkAccount event    -> google_sub
--   auth.ts createUser event     -> status, role, approved_at   (see note below)
--   admin.ts setStatus           -> status, approved_at, approved_by, suspended_at
--   admin.ts setBudget           -> daily_budget_cents, monthly_budget_cents
revoke update on users from app_rw;
grant update (
  name, email, "emailVerified", image,
  google_sub,
  status, approved_at, approved_by, suspended_at,
  daily_budget_cents, monthly_budget_cents
) on users to app_rw;

-- ---------------------------------------------------------------------------
-- INSERT, for the same reason: a table-level insert privilege lets a row be
-- created with `role = 'admin'` directly, which is the same escalation by a
-- different verb. The ONLY inserter is @auth/pg-adapter's createUser, whose
-- column list is exactly these four, and both auth packages are pinned to exact
-- versions (see auth.ts) precisely so that list cannot move underneath us.
-- `id`, `status`, `role` and `created_at` all have defaults, so omitting them
-- here does not break the insert — it makes them UNSETTABLE by the app, which is
-- the point.
revoke insert on users from app_rw;
grant insert (name, email, "emailVerified", image) on users to app_rw;

-- ---------------------------------------------------------------------------
-- WHAT THIS DELIBERATELY BREAKS, and how to recover.
--
-- auth.ts's createUser event promotes the ADMIN_EMAIL account on its first
-- sign-in with a single statement that sets status, role and approved_at
-- together. `role` is now denied to app_rw, so on a FRESH database (or a
-- restore) that statement fails as a whole — no partial promotion — and the
-- owner signs in as 'pending' like everybody else. auth.ts catches that failure
-- and logs the exact statement to run; sign-in itself is unaffected.
--
-- Promoting the first admin is therefore a one-line manual step, run as the
-- database owner rather than as app_rw:
--
--     update users set status = 'active', role = 'admin', approved_at = now()
--      where email = '<the ADMIN_EMAIL address>';
--
-- That is the trade this file makes: automatic self-promotion (a code path that
-- writes `role`) in exchange for `role` being unwritable by the application at
-- all. It is reversible with one statement if the trade turns out wrong:
--
--     grant update (role) on users to app_rw;
--
-- NOT ALSO REVOKED: `status`. The approve/deny/suspend flow in admin.ts writes
-- it by design, so it must stay writable, and a bug that flipped a pending user
-- to 'active' would bypass the waitlist. That is a smaller hole than 'admin'
-- (the waitlist gates who gets in; `role` gates who can approve them and read
-- every tenant's budget), and closing it would mean giving up admin approval
-- from the UI entirely.
