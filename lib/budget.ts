/**
 * Who pays for a Claude call, and how much they are still allowed to spend.
 *
 * The design turns on one fact recorded in lib/anthropic.ts: **web_search
 * server-tool calls are billed per search and are NOT part of the usage token
 * counts.** A meter built on `message.usage` cannot see the dominant, most
 * variable cost. Searches are ~1c each and the discover, roles and crawler
 * callers omit `maxSearches`, so a single click can issue dozens.
 *
 * Hence the ceiling is enforced INSIDE the call, by deriving `max_uses` from
 * what is left, rather than only before it. A pre-call check catches the NEXT
 * click, not this one.
 *
 * TWO PERIODS, and the daily one is the load-bearing half. The risk a cap
 * protects against is a BURST — a retry loop, a bad deploy, an uncapped
 * `max_uses` doing forty searches where six were expected. A monthly ceiling is
 * a poor fit for that: set low it locks the owner out for weeks, set high enough
 * not to, it never fires. A daily ceiling contains a burst to one day and heals
 * at midnight. The monthly one is the outer bound.
 *
 * THERE IS NO UNMETERED ADMIN. Admin is a tier with bigger numbers and the sole
 * power to raise its own ceiling. If the owner were exempt, the metering path
 * would never run on the account anyone actually watches, and the first real
 * test of the ceiling would be a stranger hitting it.
 */

/** Cents per web_search, matching lib/cost-estimate.ts. */
export const CENTS_PER_SEARCH = 1;

export type Tier = "admin" | "byo" | "free";

/**
 * BYO outranks free because the spend is the tenant's own. Admin outranks both:
 * it is metered, but against its own ceilings.
 */
export function resolveTier(input: { isAdmin: boolean; hasOwnKey: boolean }): Tier {
  if (input.isAdmin) return "admin";
  if (input.hasOwnKey) return "byo";
  return "free";
}

/**
 * Everyone except BYO is metered against the platform's money — INCLUDING admin.
 * A BYO tenant's usage is still recorded, so they can see it; it is simply not
 * blocked, because it is not the platform's money to ration.
 */
export function isMetered(tier: Tier): boolean {
  return tier !== "byo";
}

/** Only the admin may raise its own ceiling, and only from /admin. */
export function canRaiseOwnCeiling(tier: Tier): boolean {
  return tier === "admin";
}

/** Monthly period key, UTC. */
export function billingPeriod(now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/**
 * Daily period key, UTC. Deliberately the same column as the monthly key —
 * `usage_counters` is keyed on (tenant_id, period) with period as text, so a
 * second period shape needs no migration and no second table.
 */
export function dailyPeriod(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export interface Window {
  spentCents: number;
  ceilingCents: number;
}

export type ReserveVerdict =
  | { allow: true; maxSearches: number | null }
  | { allow: false; reason: "daily" | "monthly"; window: Window };

/**
 * Decide whether a call may start, and with what search cap.
 *
 * BOTH windows must pass, and the cap comes from whichever has less left — the
 * tighter of the two is the one that can actually be exceeded.
 *
 * `maxSearches` is null only for BYO. For anyone metered it is always a number,
 * because "no cap" is exactly the state that makes a ceiling unenforceable: with
 * search billing invisible to token usage, the model can keep searching until it
 * decides to stop. Never zero either — a call that can search nothing still
 * burns tokens, which is worse than refusing, because it looks like it worked.
 *
 * Daily is checked FIRST so the reason names the window that will clear soonest.
 */
export function reserveVerdict(input: {
  tier: Tier;
  daily: Window;
  monthly: Window;
  estimateCents: number;
}): ReserveVerdict {
  if (!isMetered(input.tier)) return { allow: true, maxSearches: null };

  for (const [reason, w] of [
    ["daily", input.daily],
    ["monthly", input.monthly],
  ] as const) {
    const remaining = w.ceilingCents - w.spentCents;
    if (remaining <= 0 || w.spentCents + input.estimateCents > w.ceilingCents) {
      return { allow: false, reason, window: w };
    }
  }

  const remaining = Math.min(
    input.daily.ceilingCents - input.daily.spentCents,
    input.monthly.ceilingCents - input.monthly.spentCents
  );
  return { allow: true, maxSearches: Math.max(1, Math.floor(remaining / CENTS_PER_SEARCH)) };
}

/**
 * What a capped tenant is told.
 *
 * Says plainly that it is an account limit and names the way out — a generic
 * "something went wrong" here reads as a broken app. The admin variant differs
 * because the way out differs: they can raise it themselves.
 */
export function cappedMessage(input: {
  tier: Tier;
  reason: "daily" | "monthly";
  ceilingCents: number;
  resetsOn: string;
}): string {
  const dollars = (input.ceilingCents / 100).toFixed(2);
  const window = input.reason === "daily" ? "today" : "this month";

  if (input.tier === "admin") {
    return (
      `You've hit your $${dollars} ${input.reason} limit ${window}. ` +
      `Raise it on the Accounts page, or wait until ${input.resetsOn}.`
    );
  }
  return (
    `You've used the $${dollars} of Claude usage included with a free account ${window}. ` +
    `Add your own Anthropic API key in Settings to keep going, or wait until ${input.resetsOn}.`
  );
}

/** When the named window next resets, UTC. */
export function resetsOn(reason: "daily" | "monthly", now: Date): string {
  const next =
    reason === "daily"
      ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
      : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return next.toISOString().slice(0, 10);
}
