"use server";

import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/require-actor";
import { rawQuery } from "@/lib/supabase";
import { describeWriteFailure } from "@/lib/write-failure";

/**
 * Waitlist administration.
 *
 * Impersonation ("log in as this tenant") is NOT here, and cannot be until the
 * tenancy work lands — there is nothing to impersonate while every table is
 * global. See docs/superpowers/specs/2026-08-16-multi-tenant-auth-design.md.
 */

export interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  status: string;
  role: string;
  created_at: string;
  approved_at: string | null;
}

/**
 * Admin-only, checked SERVER-SIDE on every action.
 *
 * Hiding the nav link is not a control: these are server actions, addressable by
 * an id lifted from the client bundle, so a non-admin who never sees the page can
 * still call them. Throwing (rather than returning an error string) is
 * deliberate — an authorisation failure is not a result worth rendering.
 */
async function requireAdmin() {
  const actor = await requireActor();
  if (!actor.isAdmin) throw new Error("Not authorized");
  return actor;
}

export async function listUsers(): Promise<{ users: AdminUser[]; error?: string }> {
  await requireAdmin();
  const { data, error } = await rawQuery<AdminUser>(
    `select id, email, name, status, role, created_at, approved_at
       from users
      order by case status when 'pending' then 0 else 1 end, created_at desc`
  );
  // Presence, not truthiness: the driver reports an unreachable database with an
  // EMPTY message, and `if (error)` reads that hard failure as success. The
  // message is passed through verbatim — empty string included — so
  // describeWriteFailure can substitute its own text for exactly that case.
  const described = describeWriteFailure(error ? error.message : undefined, "load accounts");
  if (described !== undefined) return { users: [], error: described };
  return { users: data };
}

async function setStatus(
  id: string,
  status: "active" | "denied" | "suspended",
  approver: string
): Promise<{ error?: string }> {
  const { error } = await rawQuery(
    `update users
        set status = $2,
            approved_at = case when $2 = 'active' then now() else approved_at end,
            approved_by = case when $2 = 'active' then $3::uuid else approved_by end,
            suspended_at = case when $2 = 'suspended' then now() else suspended_at end
      where id = $1::uuid`,
    [id, status, approver]
  );
  const described = describeWriteFailure(error ? error.message : undefined, "update that account");
  if (described !== undefined) return { error: described };

  // Sessions are checked against `status` on every read (auth.ts), so a
  // suspension takes effect on the suspended user's very next request without
  // deleting their session row. Revalidate so THIS page reflects the change.
  revalidatePath("/admin");
  return {};
}

export async function approveUser(id: string): Promise<{ error?: string }> {
  const actor = await requireAdmin();
  return setStatus(id, "active", actor.userId);
}

export async function denyUser(id: string): Promise<{ error?: string }> {
  const actor = await requireAdmin();
  return setStatus(id, "denied", actor.userId);
}

export async function suspendUser(id: string): Promise<{ error?: string }> {
  const actor = await requireAdmin();
  // Refusing to suspend yourself is not paranoia: doing so locks the only admin
  // out of the console that could undo it, and nothing in the app can recover
  // from that without direct database access.
  if (id === actor.userId) return { error: "You cannot suspend your own account." };
  return setStatus(id, "suspended", actor.userId);
}
