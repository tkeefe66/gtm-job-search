/**
 * Who pays for a Claude call, and how much they are still allowed to spend.
 *
 * The whole design turns on one fact recorded in lib/anthropic.ts: **web_search
 * server-tool calls are billed per search and are NOT part of the usage token
 * counts.** A meter built on `message.usage` therefore cannot see the dominant
 * and most variable cost. Searches are ~$0.01 each and the discover, roles and
 * crawler callers deliberately omit `maxSearches`, so a single click can issue
 * dozens.
 *
 * That is why the ceiling is enforced INSIDE the call, by deriving `max_uses`
 * from the remaining budget, rather than only before it. A pre-call check alone
 * catches the NEXT click, not this one.
 */

/** Dollars per web_search, matching lib/cost-estimate.ts. */
export const CENTS_PER_SEARCH = 1;

export type Tier = "admin" | "byo" | "free";

/**
 * Admin outranks BYO: the platform owner should not be metered even if they
 * also store a key. BYO outranks free because the spend is theirs.
 */
export function resolveTier(input: { isAdmin: boolean; hasOwnKey: boolean }): Tier {
  if (input.isAdmin) return "admin";
  if (input.hasOwnKey) return "byo";
  return "free";
}

/** Only the free tier is metered against the platform's money. */
export function isMetered(tier: Tier): boolean {
  return tier === "free";
}

/**
 * The billing period key, UTC.
 *
 * UTC rather than local, and stated rather than assumed: a period computed from
 * the server's zone would move when the host moved, and a reservation made at
 * 23:58 could reconcile into a different month than it debited.
 */
export function billingPeriod(now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

export type ReserveVerdict =
  | { allow: true; maxSearches: number | null }
  | { allow: false; reason: "exhausted"; spentCents: number; ceilingCents: number };

/**
 * Decide whether a call may start, and with what search cap.
 *
 * `maxSearches` is null ONLY for unmetered tiers. For a metered tenant it is
 * always a number, because "no cap" is the state that makes the ceiling
 * unenforceable: the model can issue searches until it decides to stop, each one
 * billed, with nothing in the loop to say no.
 *
 * At least 1 when any budget remains — a cap of 0 would produce a call that can
 * search nothing and still costs tokens, which is worse than refusing outright.
 */
export function reserveVerdict(input: {
  tier: Tier;
  spentCents: number;
  ceilingCents: number;
  estimateCents: number;
}): ReserveVerdict {
  if (!isMetered(input.tier)) return { allow: true, maxSearches: null };

  const remaining = input.ceilingCents - input.spentCents;
  if (remaining <= 0 || input.spentCents + input.estimateCents > input.ceilingCents) {
    return {
      allow: false,
      reason: "exhausted",
      spentCents: input.spentCents,
      ceilingCents: input.ceilingCents,
    };
  }

  return {
    allow: true,
    maxSearches: Math.max(1, Math.floor(remaining / CENTS_PER_SEARCH)),
  };
}

/**
 * The sentence a metered tenant sees when they run out.
 *
 * Says plainly that it is a FREE-TIER limit and names the way out. A generic
 * "something went wrong" here reads as a broken app, and the requirement was
 * explicit: make it clear when something is capped because the account is not
 * paying.
 */
export function exhaustedMessage(ceilingCents: number, resetsOn: string): string {
  const dollars = (ceilingCents / 100).toFixed(2);
  return (
    `You've used the $${dollars} of Claude usage included with a free account this month. ` +
    `Add your own Anthropic API key in Settings to keep going, or wait until ${resetsOn}.`
  );
}

/** First day of the next UTC month, for the message above. */
export function periodResetsOn(now: Date): string {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return next.toISOString().slice(0, 10);
}
