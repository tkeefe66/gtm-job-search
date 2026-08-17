import { rawQuery } from "@/lib/supabase";
import { describeWriteFailure } from "@/lib/write-failure";
import { open } from "@/lib/secret-box";
import { resolveTenantId } from "@/lib/tenant";
import { runWithBilling, billingScope, type BillingScope } from "@/lib/billing-context";
import { reserveSpend, reconcileSpend } from "@/lib/usage-store";
import {
  cappedMessage,
  isMetered,
  needsKeyMessage,
  reserveVerdict,
  resetsOn,
  resolveTier,
  unpriceableSearchMessage,
  type Tier,
} from "@/lib/budget";
import { providerFor } from "@/lib/providers/registry";
import { resolveProviderConfig, type ProviderConfig } from "@/lib/providers/resolution";
import { SearchUnavailableError } from "@/lib/model-call";

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
  const lookup = await loadTenantKey(tenantId);
  // "Could not ask" is not "no key stored". A failed read used to fall through
  // to tier "none", which tells the tenant to add an API key — a sentence about
  // their account, printed because the database is down. Presence, not
  // truthiness: the driver reports an unreachable database with an EMPTY
  // message, so the check is on the error's existence, never on its text.
  if (!lookup.ok) return { error: lookup.error };
  const ownKey = lookup.key;

  const tier = resolveTier({ isAdmin: opts.isAdmin, hasOwnKey: ownKey !== null });
  const limits = await limitsFor(tenantId, tier);

  // No key, no call. Refused BEFORE fn runs and returned as `capped` so callers
  // render it as a sentence rather than an error — it is a requirement, not a
  // failure. Previously this fell through to the platform key with a ceiling,
  // which meant approving a tenant silently spent the owner's money.
  if (tier === "none") return { capped: needsKeyMessage() };

  // The admin with no stored key of their own routes to the platform's own
  // provider and model — resolveProviderConfig(null) reproduces exactly the
  // Anthropic + Sonnet routing this app has always used.
  const config: ProviderConfig = ownKey?.config ?? resolveProviderConfig(null)!;

  // BYO spends its own money, so it is not rationed — but its usage is still
  // recorded below, so the tenant can see it.
  if (!isMetered(tier)) {
    return runScope(tier, { maxSearches: null }, opts, tenantId, now, 0, ownKey?.apiKey ?? null, config);
  }

  const { data: counters } = await rawQuery<{ period: string; spent_cents: number }>(
    `select period, spent_cents from usage_counters where tenant_id = $1`,
    [tenantId],
    tenantId
  );
  const spent = (p: string) => counters.find((c) => c.period === p)?.spent_cents ?? 0;
  const daily = { spentCents: spent(now.toISOString().slice(0, 10)), ceilingCents: limits.dailyCents };
  const monthly = { spentCents: spent(now.toISOString().slice(0, 7)), ceilingCents: limits.monthlyCents };

  // One search, priced by the adapter — which is the definition of the number.
  const centsPerSearch = providerFor(config.providerId).costCents(
    { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, searches: 1 },
    config.model
  );

  const verdict = reserveVerdict({ tier, daily, monthly, estimateCents: opts.estimateCents, centsPerSearch });
  if (!verdict.allow) {
    // A search this provider prices at zero cannot be rationed at all, so the
    // call is refused before it starts rather than run with a cap derived from
    // a division by zero. Not a ceiling the tenant has hit, so not cappedMessage.
    if (verdict.reason === "unpriceable") {
      console.error(
        `metered: ${config.providerId}/${config.model} prices a search at ${centsPerSearch}c — refusing the metered call`
      );
      return { capped: unpriceableSearchMessage() };
    }
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

  return runScope(
    tier,
    { maxSearches: verdict.maxSearches },
    opts,
    tenantId,
    now,
    opts.estimateCents,
    ownKey?.apiKey ?? null,
    config
  );
}

interface TenantKey {
  apiKey: string;
  config: ProviderConfig;
}

/**
 * This tenant's key AND how to route it — or "no usable key", or "could not
 * ask". The third case is a separate arm ON PURPOSE.
 *
 * `key: null` covers four cases that are all "no usable key": nothing stored, a
 * row that will not open (tampered, moved between tenants, or written under an
 * encryption key that no longer exists), a key marked failed, and a stored
 * provider this build has no adapter for. None of them may silently fall back
 * to the platform key or to Anthropic — either would bill somebody who believes
 * they are paying their own vendor, which is the failure this whole tier is
 * meant to make impossible.
 *
 * A FAILED READ is none of those. An unreachable database returns `data: []`
 * with an error whose message is the EMPTY STRING (pg's AggregateError — see
 * lib/write-failure.ts), so discarding the error made a dead database
 * indistinguishable from a tenant who never stored a key, and printed "add your
 * API key" at them while Postgres was down.
 */
type KeyLookup = { ok: true; key: TenantKey | null } | { ok: false; error: string };

async function loadTenantKey(tenantId: string): Promise<KeyLookup> {
  const { data, error } = await rawQuery<{
    key_id: string;
    aad_version: number;
    ciphertext: string;
    nonce: string;
    auth_tag: string;
    provider: string;
    model: string | null;
  }>(
    `select key_id, aad_version, ciphertext, nonce, auth_tag, provider, model
       from tenant_api_keys where tenant_id = $1 and status = 'ok'`,
    [tenantId],
    tenantId
  );

  // The reader idiom: describeWriteFailure, then branch on !== undefined. The
  // transport hands back an object-or-null whose MESSAGE may be empty, and it
  // is the message that gets shown, so the description is substituted here.
  const described = describeWriteFailure(
    error === null ? undefined : error.message,
    "load your API key"
  );
  if (described !== undefined) {
    console.error(`metered: could not read the tenant's stored API key — ${error?.message || "(no message)"}`);
    return { ok: false, error: described };
  }

  if (data.length === 0) return { ok: true, key: null };
  const row = data[0];

  const config = resolveProviderConfig({ provider: row.provider, model: row.model });
  if (config === null) {
    console.error(`metered: a stored API key names a provider this build cannot route: ${row.provider}`);
    return { ok: true, key: null };
  }

  const plain = open(
    {
      keyId: row.key_id,
      aadVersion: row.aad_version,
      ciphertext: row.ciphertext,
      nonce: row.nonce,
      authTag: row.auth_tag,
    },
    { tenantId, provider: row.provider, model: row.model }
  );
  if (plain === null) {
    // Loud, because this is not a normal state: the row exists and cannot be
    // opened, which means tampering, a moved row, or a rotated encryption key.
    console.error(`metered: a stored API key for a tenant could not be opened`);
    return { ok: true, key: null };
  }
  return { ok: true, key: { apiKey: plain, config } };
}

async function runScope<T>(
  tier: Tier,
  caps: { maxSearches: number | null },
  opts: { action: string; estimateCents: number; fn: () => Promise<T> },
  tenantId: string,
  now: Date,
  reservedCents: number,
  ownKey: string | null,
  config: ProviderConfig
): Promise<MeteredResult<T>> {
  const provider = providerFor(config.providerId);
  const scope: BillingScope = {
    maxSearches: caps.maxSearches,
    // The platform key is reachable ONLY by the admin, whose key it is. Every
    // other tenant arrives here with their own key, because tier "none" was
    // refused above. The `??` is not a fallback for tenants — it is the admin
    // branch, and a keyless non-admin can never reach it.
    apiKey: ownKey ?? (tier === "admin" ? process.env.ANTHROPIC_API_KEY || "" : ""),
    provider: config.providerId,
    model: config.model,
    searches: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };

  try {
    const result = await runWithBilling(scope, opts.fn);
    return { result };
  } catch (err) {
    // A search refused because this provider cannot cap uses in-request is a
    // REFUSAL, not a crash: the caller renders it as a sentence, the same way a
    // hit ceiling is rendered. Anything else propagates untouched.
    if (err instanceof SearchUnavailableError) return { capped: err.message };
    throw err;
  } finally {
    // In a finally: a call that throws halfway still issued searches, and
    // charging only successful calls would make a failing loop free. Priced
    // through the adapter — never a hardcoded rate — so a tenant on a
    // different provider or model is billed at that provider's own price.
    const actual = provider.costCents(
      {
        inputTokens: scope.inputTokens,
        cachedInputTokens: scope.cachedInputTokens,
        outputTokens: scope.outputTokens,
        searches: scope.searches,
      },
      scope.model
    );
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
