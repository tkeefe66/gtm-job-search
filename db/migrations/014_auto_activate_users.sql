-- Removes the manual approval gate: new users are active immediately instead
-- of landing on 'pending' and waiting for an admin to click Approve in
-- /admin. 'suspended'/'denied' are untouched — this is not a removal of
-- moderation, only of the default wait.
--
-- Two changes, matching the two places 'pending' could otherwise still
-- happen: the column default (governs every future INSERT, which is
-- @auth/pg-adapter's createUser — see auth.ts) and a one-time backfill for
-- anyone stuck in 'pending' right now, so this migration itself is what lets
-- them in rather than requiring an admin to work through a backlog first.
--
-- Deliberately scoped to status = 'pending' only: a 'suspended' or 'denied'
-- row was a deliberate admin action and must not be silently reactivated by
-- an unrelated migration.
alter table users alter column status set default 'active';

update users
   set status = 'active',
       approved_at = coalesce(approved_at, now())
 where status = 'pending';
