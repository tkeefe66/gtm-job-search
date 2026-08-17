/**
 * Who pays for a Claude call, and how much they are still allowed to spend.
 *
 * The design turns on one fact recorded in lib/providers/types.ts: **web_search
 * server-tool calls are billed per search and are NOT part of the usage token
 * counts.** A meter built on `message.usage` cannot see the dominant, most
 * variable cost. Searches are ~1c each and the discover, roles and crawler
 * callers omit `maxSearches`, so a single click can issue dozens.
 *
 * Hence the ceiling is enforced INSIDE the call, by deriving `max_uses` from
 * what is left, rather than only before it. A pre-call check catches the NEXT
 * click, not this one.
 *
 * TWO PERIODS, and the daily one is the load-bearing half. They apply to the
 * ADMIN only — nobody else spends the platform's key. The risk a cap
 * protects against is a BURST — a retry loop, a bad deploy, an uncapped
 * `max_uses` doing forty searches where six were expected. A monthly ceiling is
 * a poor fit for that: set low it locks the owner out for weeks, set high enough
 * not to, it never fires. A daily ceiling contains a burst to one day and heals
 * at midnight. The monthly one is the outer bound.
 *
 * THERE IS NO UNMETERED ADMIN and NO FREE TIER. Every other tenant brings their
 * own key or cannot call anything, so the meter now protects exactly one
 * account: the owner's, against a runaway.
 */

export type Tier = "admin" | "byo" | "none";

/**
 * "none" means the tenant has stored no API key of their own.
 *
 * There is NO free tier. A tenant without a key cannot call anything — they are
 * refused before the call, not metered against the platform's key. The platform
 * key is reachable only by the admin, whose key it already is.
 *
 * This matters more than a product preference: the previous shape resolved a
 * keyless tenant to the platform key with a ceiling, which meant approving
 * somebody silently spent the owner's money at up to the daily cap.
 */

/**
 * Admin first, because the platform key is the admin's own. Then a stored key.
 * Anyone else is "none" and cannot call anything.
 */
export function resolveTier(input: { isAdmin: boolean; hasOwnKey: boolean }): Tier {
  if (input.isAdmin) return "admin";
  if (input.hasOwnKey) return "byo";
  return "none";
}

/**
 * Only the admin is metered, because only the admin spends the platform's key.
 * BYO spends their own money — recorded, never rationed. "none" never reaches a
 * call at all, so it has no meter to be under.
 */
export function isMetered(tier: Tier): boolean {
  return tier === "admin";
}

/** What a keyless tenant is told. Not an error — a requirement. */
export function needsKeyMessage(): string {
  return (
    "This app runs on your own model API key. Add one in Settings to start " +
    "searching — nothing is charged to anyone else."
  );
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
  | { allow: false; reason: "daily" | "monthly"; window: Window }
  | { allow: false; reason: "unpriceable" };

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
  /** From the resolved provider — searches are not a cents-per-unit constant
   *  shared across vendors, and a cap computed at the wrong price is not a cap. */
  centsPerSearch: number;
}): ReserveVerdict {
  if (!isMetered(input.tier)) return { allow: true, maxSearches: null };

  // A search this provider prices at zero (or below) is not a cheap search, it
  // is an UNPRICEABLE one, and the metered call is refused rather than run.
  //
  // Without this, `remaining / 0` is Infinity: it is a number, so it passes
  // mustRefuseSearch, becomes `max_uses: Infinity`, and serialises to JSON as
  // `null` — silently uncapped, which is the exact outcome searchCapEnforcement
  // exists to make impossible. Not hypothetical: Gemini bills per grounded
  // REQUEST, so a per-search cost of zero is what that adapter will produce.
  //
  // Refused rather than treated as an unenforceable cap, and the two are the
  // same decision anyway — mustRefuseSearch already refuses a metered call whose
  // ceiling cannot be enforced in-request, and a ceiling that cannot be
  // converted into a number of searches is unenforceable in exactly that sense.
  // It refuses metered calls that would never have searched, too: that is
  // deliberate. This layer cannot know whether `fn` will search, and the same
  // zero flows into reconcileSpend, so searches would be recorded at no cost
  // either — the meter is broken for the whole call, not just its search half.
  //
  // Written `!(x > 0)` rather than `x <= 0` so a NaN price — an adapter that
  // returned nothing usable at all — is refused rather than compared false.
  if (!(input.centsPerSearch > 0)) return { allow: false, reason: "unpriceable" };

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
  return { allow: true, maxSearches: Math.max(1, Math.floor(remaining / input.centsPerSearch)) };
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

  // Only the admin can be capped — nobody else spends the platform's key.
  return (
    `You've hit your $${dollars} ${input.reason} limit ${window}. ` +
    `Raise it on the Accounts page, or wait until ${input.resetsOn}.`
  );
}

/**
 * What a tenant is told when the resolved provider prices a search at zero.
 *
 * Not a limit they have hit and not something they can raise, so it does not
 * borrow cappedMessage's wording — it is a routing fault, and the only way out
 * is a different model. Rendered as a refusal (`capped`), not an error, because
 * nothing failed: the call was never started.
 */
export function unpriceableSearchMessage(): string {
  return (
    "This app cannot meter searches on the model this account is routed to, " +
    "so the request was not started. Choose a different model in Settings."
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
