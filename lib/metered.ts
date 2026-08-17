import { rawQuery } from "@/lib/supabase";
import { open } from "@/lib/secret-box";
import { resolveTenantId } from "@/lib/tenant";
import { runWithBilling, billingScope, type BillingScope } from "@/lib/billing-context";
import { reserveSpend, reconcileSpend } from "@/lib/usage-store";
import {
  CENTS_PER_SEARCH,
  cappedMessage,
  isMetered,
  needsKeyMessage,
  reserveVerdict,
  resetsOn,
  resolveTier,
  type Tier,
} from "@/lib/budget";

/**
 * Runs a block of Claude work against a tenant's budget.
 *
 * Three things happen around `fn`, and the middle one is the whole point:
 *
 *   1. RESERVE the estimate atomically against both windows. Refused means the
 *      call never starts.
 *   2. Hand `fn` a search cap derived from what is LEFT. This is what makes the
 *      ceiling enforceable — web_search calls are billed per search and are
 *      invisible to token usage, so a pre-call check alone catches the next
 *      click, not this one.
 *   3. RECONCILE what it actually cost, and record the event.
 *
 * Reconciliation runs in a `finally`, so a call that throws halfway still gets
 * charged for the searches it issued. Charging only successful calls would make
 * a failing loop free.
 */

interface Limits {
  monthlyCents: number;
  dailyCents: number;
}

async function limitsFor(tenantId: string, tier: Tier): Promise<Limits> {
  const { data: settings } = await rawQuery<{ key: string; value: unknown }>(
    `select key, value from platform_settings`
  );
  const num = (k: string, fallback: number) => {
    const v = settings.find((s) => s.key === k)?.value;
    return typeof v === "number" ? v : fallback;
  };

  const { data: rows } = await rawQuery<{
    monthly_budget_cents: number | null;
    daily_budget_cents: number | null;
  }>(
    `select monthly_budget_cents, daily_budget_cents from users where id = $1`,
    [tenantId]
  );
  const own = rows[0];

  // Per-tenant override, else the tier's platform default. NULL means "follow
  // the default", so raising a default lifts everyone never given a number.
  const admin = tier === "admin";
  return {
    monthlyCents:
      own?.monthly_budget_cents ??
      num(admin ? "adminMonthlyBudgetCents" : "defaultMonthlyBudgetCents", admin ? 10_000 : 1_000),
    dailyCents:
      own?.daily_budget_cents ??
      num(admin ? "adminDailyBudgetCents" : "defaultDailyBudgetCents", admin ? 1_000 : 200),
  };
}

export interface MeteredResult<T> {
  result?: T;
  /** Present when the budget refused the call. A refusal, not a failure. */
  capped?: string;
  /** Present (empty string included) when something actually failed. */
  error?: string;
}

export async function withBudget<T>(opts: {
  action: string;
  /** What this is expected to cost, in cents. See lib/cost-estimate.ts. */
  estimateCents: number;
  isAdmin: boolean;
  fn: () => Promise<T>;
}): Promise<MeteredResult<T>> {
  // NESTED CALLS RUN DIRECTLY. scoreFit is metered in its own right — it is
  // callable straight from the client — but it also runs inside ingestRoles,
  // which is already inside a metered action. Without this guard the inner call
  // would reserve a second time against the same budget and record a second
  // event, double-charging every role a search finds.
  //
  // The outer scope still collects the inner call's usage, because
  // recordUsage writes to whichever scope is active.
  if (billingScope() !== null) {
    return { result: await opts.fn() };
  }

  const tenantId = await resolveTenantId();
  const now = new Date();

  // The tenant's own key, decrypted here and nowhere else. Loading it BEFORE
  // deciding the tier matters: a stored key that will not open is not a BYO
  // tenant, and treating them as one would leave them unmetered AND unable to
  // call anything.
  const ownKey = await loadTenantKey(tenantId);
  const tier = resolveTier({ isAdmin: opts.isAdmin, hasOwnKey: ownKey !== null });
  const limits = await limitsFor(tenantId, tier);

  // No key, no call. Refused BEFORE fn runs and returned as `capped` so callers
  // render it as a sentence rather than an error — it is a requirement, not a
  // failure. Previously this fell through to the platform key with a ceiling,
  // which meant approving a tenant silently spent the owner's money.
  if (tier === "none") return { capped: needsKeyMessage() };

  // BYO spends its own money, so it is not rationed — but its usage is still
  // recorded below, so the tenant can see it.
  if (!isMetered(tier)) {
    return runScope(tier, { maxSearches: null }, opts, tenantId, now, 0, ownKey);
  }

  const { data: counters } = await rawQuery<{ period: string; spent_cents: number }>(
    `select period, spent_cents from usage_counters where tenant_id = $1`,
    [tenantId],
    tenantId
  );
  const spent = (p: string) => counters.find((c) => c.period === p)?.spent_cents ?? 0;
  const daily = { spentCents: spent(now.toISOString().slice(0, 10)), ceilingCents: limits.dailyCents };
  const monthly = { spentCents: spent(now.toISOString().slice(0, 7)), ceilingCents: limits.monthlyCents };

  const verdict = reserveVerdict({ tier, daily, monthly, estimateCents: opts.estimateCents });
  if (!verdict.allow) {
    return {
      capped: cappedMessage({
        tier,
        reason: verdict.reason,
        ceilingCents: verdict.window.ceilingCents,
        resetsOn: resetsOn(verdict.reason, now),
      }),
    };
  }

  const reserved = await reserveSpend({
    tenantId,
    estimateCents: opts.estimateCents,
    dailyCeilingCents: limits.dailyCents,
    monthlyCeilingCents: limits.monthlyCents,
    now,
  });
  // Presence, not truthiness — the driver reports an unreachable database with
  // an empty message, and `if (error)` would read that as a clean refusal.
  if (reserved.error !== undefined) return { error: reserved.error };
  if (!reserved.ok) {
    // Lost a race between the check above and the reservation. The atomic
    // statement is what makes this correct rather than the check.
    return {
      capped: cappedMessage({
        tier,
        reason: "daily",
        ceilingCents: limits.dailyCents,
        resetsOn: resetsOn("daily", now),
      }),
    };
  }

  return runScope(tier, { maxSearches: verdict.maxSearches }, opts, tenantId, now, opts.estimateCents, ownKey);
}

/**
 * Decrypts this tenant's stored key, or null.
 *
 * Null covers three cases that are all "no usable key": nothing stored, a row
 * that will not open (tampered, moved between tenants, or written under an
 * encryption key that no longer exists), and a key marked failed. None of them
 * may silently fall back to the platform key — that would bill the platform for
 * a tenant who believes they are paying, which is the failure this whole tier is
 * meant to make impossible.
 */
async function loadTenantKey(tenantId: string): Promise<string | null> {
  const { data } = await rawQuery<{
    key_id: string;
    ciphertext: string;
    nonce: string;
    auth_tag: string;
    aad_version: number;
  }>(
    `select key_id, ciphertext, nonce, auth_tag, aad_version
       from tenant_api_keys where tenant_id = $1 and status = 'ok'`,
    [tenantId],
    tenantId
  );
  if (data.length === 0) return null;

  const plain = open(
    {
      keyId: data[0].key_id,
      aadVersion: data[0].aad_version,
      ciphertext: data[0].ciphertext,
      nonce: data[0].nonce,
      authTag: data[0].auth_tag,
    },
    { tenantId, provider: "anthropic", model: null }
  );
  if (plain === null) {
    // Loud, because this is not a normal state: the row exists and cannot be
    // opened, which means tampering, a moved row, or a rotated encryption key.
    console.error(`metered: a stored API key for a tenant could not be opened`);
  }
  return plain;
}

async function runScope<T>(
  tier: Tier,
  caps: { maxSearches: number | null },
  opts: { action: string; estimateCents: number; fn: () => Promise<T> },
  tenantId: string,
  now: Date,
  reservedCents: number,
  ownKey: string | null
): Promise<MeteredResult<T>> {
  const scope: BillingScope = {
    maxSearches: caps.maxSearches,
    // The platform key is reachable ONLY by the admin, whose key it is. Every
    // other tenant arrives here with their own key, because tier "none" was
    // refused above. The `??` is not a fallback for tenants — it is the admin
    // branch, and a keyless non-admin can never reach it.
    apiKey: ownKey ?? (tier === "admin" ? process.env.ANTHROPIC_API_KEY || "" : ""),
    searches: 0,
    inputTokens: 0,
    outputTokens: 0,
  };

  try {
    const result = await runWithBilling(scope, opts.fn);
    return { result };
  } finally {
    // In a finally: a call that throws halfway still issued searches, and
    // charging only successful calls would make a failing loop free.
    const actual =
      scope.searches * CENTS_PER_SEARCH +
      Math.round((scope.inputTokens * 3 + scope.outputTokens * 15) / 10_000);
    await reconcileSpend({
      tenantId,
      estimateCents: reservedCents,
      actualCents: actual,
      action: opts.action,
      searches: scope.searches,
      inputTokens: scope.inputTokens,
      outputTokens: scope.outputTokens,
      billedTo: tier === "byo" ? "tenant" : "platform",
      now,
    });
  }
}
