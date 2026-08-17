import { describe, expect, test } from "vitest";
import {
  resolveTier,
  isMetered,
  billingPeriod,
  reserveVerdict,
  periodResetsOn,
  exhaustedMessage,
  CENTS_PER_SEARCH,
} from "./budget";

describe("resolveTier", () => {
  test("admin outranks a stored key", () => {
    expect(resolveTier({ isAdmin: true, hasOwnKey: true })).toBe("admin");
    expect(resolveTier({ isAdmin: true, hasOwnKey: false })).toBe("admin");
  });

  test("a stored key means the spend is theirs", () => {
    expect(resolveTier({ isAdmin: false, hasOwnKey: true })).toBe("byo");
  });

  test("everyone else is metered", () => {
    expect(resolveTier({ isAdmin: false, hasOwnKey: false })).toBe("free");
  });

  test("only the free tier is metered against the platform's money", () => {
    expect(isMetered("free")).toBe(true);
    expect(isMetered("byo")).toBe(false);
    expect(isMetered("admin")).toBe(false);
  });
});

describe("billingPeriod", () => {
  test("is UTC year-month", () => {
    expect(billingPeriod(new Date("2026-08-17T03:00:00Z"))).toBe("2026-08");
    expect(billingPeriod(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01");
  });

  // A period computed from the host's zone would move when the host moved, and
  // a reservation made near midnight could reconcile into a different month
  // than it debited.
  test("does not shift with a late-evening local time", () => {
    expect(billingPeriod(new Date("2026-08-31T23:59:59Z"))).toBe("2026-08");
    expect(billingPeriod(new Date("2026-09-01T00:00:01Z"))).toBe("2026-09");
  });
});

describe("reserveVerdict", () => {
  test("unmetered tiers are never capped and get no search limit", () => {
    for (const tier of ["admin", "byo"] as const) {
      expect(
        reserveVerdict({ tier, spentCents: 999_999, ceilingCents: 1, estimateCents: 500 })
      ).toEqual({ allow: true, maxSearches: null });
    }
  });

  // THE point of the module. A metered call always carries a search cap, because
  // "no cap" is the state that makes the ceiling unenforceable: web_search
  // billing is invisible to token usage, so without max_uses the model can spend
  // until it decides to stop.
  test("a metered call always gets a search cap, never null", () => {
    const v = reserveVerdict({
      tier: "free",
      spentCents: 0,
      ceilingCents: 1000,
      estimateCents: 100,
    });
    expect(v.allow).toBe(true);
    if (!v.allow) throw new Error("unreachable");
    expect(v.maxSearches).not.toBeNull();
    expect(v.maxSearches).toBe(1000 / CENTS_PER_SEARCH);
  });

  test("the cap shrinks as the budget is consumed", () => {
    const early = reserveVerdict({ tier: "free", spentCents: 0, ceilingCents: 1000, estimateCents: 10 });
    const late = reserveVerdict({ tier: "free", spentCents: 900, ceilingCents: 1000, estimateCents: 10 });
    if (!early.allow || !late.allow) throw new Error("unreachable");
    expect(late.maxSearches!).toBeLessThan(early.maxSearches!);
    expect(late.maxSearches).toBe(100);
  });

  test("refuses when the estimate would cross the ceiling", () => {
    const v = reserveVerdict({ tier: "free", spentCents: 950, ceilingCents: 1000, estimateCents: 100 });
    expect(v).toEqual({
      allow: false,
      reason: "exhausted",
      spentCents: 950,
      ceilingCents: 1000,
    });
  });

  test("refuses once nothing remains, even for a free call", () => {
    const v = reserveVerdict({ tier: "free", spentCents: 1000, ceilingCents: 1000, estimateCents: 0 });
    expect(v.allow).toBe(false);
  });

  // A cap of 0 produces a call that can search nothing and still burns tokens —
  // worse than refusing, because it looks like it worked.
  test("never issues a cap of zero while budget remains", () => {
    const v = reserveVerdict({ tier: "free", spentCents: 999, ceilingCents: 1000, estimateCents: 0 });
    if (!v.allow) throw new Error("unreachable");
    expect(v.maxSearches).toBeGreaterThanOrEqual(1);
  });

  test("spending exactly to the ceiling is allowed; past it is not", () => {
    expect(
      reserveVerdict({ tier: "free", spentCents: 0, ceilingCents: 100, estimateCents: 100 }).allow
    ).toBe(true);
    expect(
      reserveVerdict({ tier: "free", spentCents: 0, ceilingCents: 100, estimateCents: 101 }).allow
    ).toBe(false);
  });
});

describe("the message a capped tenant sees", () => {
  test("names the limit as a free-account one and the way out", () => {
    const msg = exhaustedMessage(1000, "2026-09-01");
    expect(msg).toContain("$10.00");
    expect(msg).toContain("free account");
    expect(msg).toContain("Anthropic API key");
    expect(msg).toContain("2026-09-01");
  });

  test("the reset date is the first of the next UTC month", () => {
    expect(periodResetsOn(new Date("2026-08-17T03:00:00Z"))).toBe("2026-09-01");
    expect(periodResetsOn(new Date("2026-12-31T23:00:00Z"))).toBe("2027-01-01");
  });
});
