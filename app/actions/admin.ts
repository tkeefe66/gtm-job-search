"use server";

import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/require-actor";
import { isPlatform } from "@/lib/platform-context";
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

  // The user row is re-joined on every session read (auth.ts) and the status it
  // carries is enforced at every surface (readActor, signInView), so a
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

/**
 * The tenants scheduled work should act for: everyone currently allowed in.
 *
 * Platform-callable, like getDueCompanies and repairJobLinks — the cron route
 * holds no session, and its CRON_SECRET check is what authorises it. Reads
 * `users`, which is auth schema with no tenant_id and no RLS policy, so it is
 * legitimately cross-tenant; that is the whole point of enumerating.
 *
 * Only 'active'. A pending, denied or suspended account must not have its
 * companies crawled — that would spend money on somebody who cannot sign in.
 *
 * PLATFORM ONLY, and the check is explicit rather than inherited. Its two
 * sibling cron actions get this protection for free — getDueCompanies and
 * repairJobLinks both call resolveTenantId(), which falls through to
 * requireActor() and throws for a caller with no session. This one reads
 * `users` directly, so it never touched that path: it was an exported server
 * action, addressable by an id lifted from the client bundle, that returned
 * every active tenant's uuid and admin flag to anyone who asked. Nothing else
 * accepts a tenant id from the client, so the ids were not directly spendable —
 * it was an enumeration leak, not an isolation break, and it is closed here
 * rather than left as a documented exemption.
 *
 * "Not authenticated" deliberately, matching requireActor's own wording: it is
 * what app/actions/auth-required.test.ts asserts, and this function's removal
 * from that test's exemption list is what now pins the check.
 */
export async function listCrawlableTenants(): Promise<{
  tenants: { id: string; isAdmin: boolean }[];
  error?: string;
}> {
  if (!isPlatform()) throw new Error("Not authenticated");
  // The role comes back too: the crawl is metered per tenant, and the tier
  // decides which ceilings apply. Without it every scheduled crawl would be
  // billed against the free defaults, including the owner's.
  const { data, error } = await rawQuery<{ id: string; role: string }>(
    `select id, role from users where status = 'active' order by created_at`
  );
  const described = describeWriteFailure(
    error ? error.message : undefined,
    "list tenants to crawl"
  );
  if (described !== undefined) return { tenants: [], error: described };
  return { tenants: data.map((r) => ({ id: r.id, isAdmin: r.role === "admin" })) };
}

export interface TenantBudget {
  id: string;
  email: string;
  role: string;
  dailyCents: number;
  monthlyCents: number;
  spentTodayCents: number;
  spentMonthCents: number;
  hasOwnKey: boolean;
}

/**
 * Spend and ceilings for every tenant.
 *
 * usage_counters is under FORCE RLS and app_rw is NOBYPASSRLS, so there is no
 * cross-tenant SELECT to write — the admin genuinely cannot read another
 * tenant's counters. This enters each tenant's scope in turn instead, one
 * explicit read per tenant. That is slower and it is the honest shape: the
 * isolation is not being bypassed, it is being used deliberately, N times, from
 * an action that checks the admin role server-side.
 */
export async function getBudgetOverview(): Promise<{
  tenants: TenantBudget[];
  error?: string;
}> {
  await requireAdmin();

  const { data: users, error } = await rawQuery<{
    id: string;
    email: string;
    role: string;
    daily_budget_cents: number | null;
    monthly_budget_cents: number | null;
  }>(
    `select id, email, role, daily_budget_cents, monthly_budget_cents
       from users where status = 'active' order by role desc, created_at`
  );
  const described = describeWriteFailure(
    error ? error.message : undefined,
    "load budgets"
  );
  if (described !== undefined) return { tenants: [], error: described };

  const { data: defaults } = await rawQuery<{ key: string; value: unknown }>(
    `select key, value from platform_settings`
  );
  const num = (k: string, f: number) => {
    const v = defaults.find((d) => d.key === k)?.value;
    return typeof v === "number" ? v : f;
  };

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const month = now.toISOString().slice(0, 7);

  const tenants: TenantBudget[] = [];
  for (const u of users) {
    const admin = u.role === "admin";
    // Scoped to THIS tenant, so the policy permits the read.
    const { data: counters } = await rawQuery<{ period: string; spent_cents: number }>(
      `select period, spent_cents from usage_counters where tenant_id = $1`,
      [u.id],
      u.id
    );
    const { data: keys } = await rawQuery<{ tenant_id: string }>(
      `select tenant_id from tenant_api_keys where tenant_id = $1 and status = 'ok'`,
      [u.id],
      u.id
    );
    const spent = (p: string) => counters.find((c) => c.period === p)?.spent_cents ?? 0;

    tenants.push({
      id: u.id,
      email: u.email,
      role: u.role,
      dailyCents:
        u.daily_budget_cents ??
        num(admin ? "adminDailyBudgetCents" : "defaultDailyBudgetCents", admin ? 1000 : 200),
      monthlyCents:
        u.monthly_budget_cents ??
        num(admin ? "adminMonthlyBudgetCents" : "defaultMonthlyBudgetCents", admin ? 10_000 : 1000),
      spentTodayCents: spent(today),
      spentMonthCents: spent(month),
      hasOwnKey: keys.length > 0,
    });
  }
  return { tenants };
}

/**
 * Set a tenant's ceilings. The admin's own row included — that is the escape
 * hatch that makes a hard cap safe to have at all.
 *
 * A runaway loop cannot press this button, which is why the protection still
 * holds while lockout does not.
 */
export async function setBudget(
  id: string,
  dailyCents: number,
  monthlyCents: number
): Promise<{ error?: string }> {
  await requireAdmin();

  // Refuse nonsense rather than storing it: a daily ceiling above the monthly
  // one can never bind, so the daily protection would silently stop existing.
  if (!Number.isFinite(dailyCents) || !Number.isFinite(monthlyCents)) {
    return { error: "Budgets must be numbers." };
  }
  if (dailyCents < 0 || monthlyCents < 0) {
    return { error: "Budgets cannot be negative." };
  }
  if (dailyCents > monthlyCents) {
    return { error: "The daily limit cannot exceed the monthly limit — it would never apply." };
  }

  const { error } = await rawQuery(
    `update users set daily_budget_cents = $2, monthly_budget_cents = $3 where id = $1::uuid`,
    [id, Math.round(dailyCents), Math.round(monthlyCents)]
  );
  const described = describeWriteFailure(
    error ? error.message : undefined,
    "save that budget"
  );
  if (described !== undefined) return { error: described };
  revalidatePath("/admin");
  return {};
}
