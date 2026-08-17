import { describe, expect, test } from "vitest";
import {
  resolveTier,
  isMetered,
  canRaiseOwnCeiling,
  billingPeriod,
  dailyPeriod,
  reserveVerdict,
  resetsOn,
  cappedMessage,
  CENTS_PER_SEARCH,
  type Window,
} from "./budget";

const open: Window = { spentCents: 0, ceilingCents: 10_000 };

describe("tiers", () => {
  test("admin outranks a stored key; a stored key outranks nothing", () => {
    expect(resolveTier({ isAdmin: true, hasOwnKey: true })).toBe("admin");
    expect(resolveTier({ isAdmin: false, hasOwnKey: true })).toBe("byo");
    expect(resolveTier({ isAdmin: false, hasOwnKey: false })).toBe("free");
  });

  // The decision this file was rewritten for. An unmetered admin never exercises
  // the metering path, so the first real test of the ceiling would be a stranger
  // hitting it — on an account nobody is watching.
  test("ADMIN IS METERED; only BYO is not", () => {
    expect(isMetered("admin")).toBe(true);
    expect(isMetered("free")).toBe(true);
    expect(isMetered("byo")).toBe(false);
  });

  test("only admin may raise its own ceiling", () => {
    expect(canRaiseOwnCeiling("admin")).toBe(true);
    expect(canRaiseOwnCeiling("free")).toBe(false);
    expect(canRaiseOwnCeiling("byo")).toBe(false);
  });
});

describe("period keys", () => {
  test("monthly and daily are both UTC", () => {
    const t = new Date("2026-08-17T03:00:00Z");
    expect(billingPeriod(t)).toBe("2026-08");
    expect(dailyPeriod(t)).toBe("2026-08-17");
  });

  test("do not shift across a UTC midnight boundary", () => {
    expect(dailyPeriod(new Date("2026-08-17T23:59:59Z"))).toBe("2026-08-17");
    expect(dailyPeriod(new Date("2026-08-18T00:00:01Z"))).toBe("2026-08-18");
    expect(billingPeriod(new Date("2026-08-31T23:59:59Z"))).toBe("2026-08");
  });
});

describe("reserveVerdict", () => {
  test("BYO is never blocked and gets no search cap", () => {
    expect(
      reserveVerdict({
        tier: "byo",
        daily: { spentCents: 99_999, ceilingCents: 1 },
        monthly: { spentCents: 99_999, ceilingCents: 1 },
        estimateCents: 500,
      })
    ).toEqual({ allow: true, maxSearches: null });
  });

  // The reason the ceiling is enforceable at all: without max_uses the model can
  // keep issuing individually-billed searches that token usage never reports.
  test("a metered call always carries a search cap, never null", () => {
    for (const tier of ["free", "admin"] as const) {
      const v = reserveVerdict({ tier, daily: open, monthly: open, estimateCents: 10 });
      expect(v.allow).toBe(true);
      if (!v.allow) throw new Error("unreachable");
      expect(v.maxSearches).not.toBeNull();
    }
  });

  test("the cap comes from whichever window has less left", () => {
    const v = reserveVerdict({
      tier: "free",
      daily: { spentCents: 900, ceilingCents: 1000 },   // 100 left
      monthly: { spentCents: 0, ceilingCents: 10_000 }, // 10000 left
      estimateCents: 10,
    });
    if (!v.allow) throw new Error("unreachable");
    expect(v.maxSearches).toBe(100 / CENTS_PER_SEARCH);
  });

  test("the DAILY window can block while the monthly one is wide open", () => {
    const v = reserveVerdict({
      tier: "admin",
      daily: { spentCents: 1000, ceilingCents: 1000 },
      monthly: { spentCents: 1000, ceilingCents: 100_000 },
      estimateCents: 10,
    });
    expect(v.allow).toBe(false);
    if (v.allow) throw new Error("unreachable");
    expect(v.reason).toBe("daily");
  });

  test("the monthly window blocks even on a fresh day", () => {
    const v = reserveVerdict({
      tier: "free",
      daily: { spentCents: 0, ceilingCents: 1000 },
      monthly: { spentCents: 10_000, ceilingCents: 10_000 },
      estimateCents: 10,
    });
    expect(v.allow).toBe(false);
    if (v.allow) throw new Error("unreachable");
    expect(v.reason).toBe("monthly");
  });

  // Daily is checked first so the message names the window that clears soonest —
  // "wait until tomorrow" is better advice than "wait until the 1st" when both
  // are true.
  test("when both windows are exhausted the reason is the daily one", () => {
    const v = reserveVerdict({
      tier: "free",
      daily: { spentCents: 1000, ceilingCents: 1000 },
      monthly: { spentCents: 10_000, ceilingCents: 10_000 },
      estimateCents: 1,
    });
    if (v.allow) throw new Error("unreachable");
    expect(v.reason).toBe("daily");
  });

  test("never issues a cap of zero while any budget remains", () => {
    const v = reserveVerdict({
      tier: "free",
      daily: { spentCents: 999, ceilingCents: 1000 },
      monthly: open,
      estimateCents: 0,
    });
    if (!v.allow) throw new Error("unreachable");
    expect(v.maxSearches).toBeGreaterThanOrEqual(1);
  });

  test("spending exactly to a ceiling is allowed; one cent past is not", () => {
    const at = { spentCents: 0, ceilingCents: 100 };
    expect(reserveVerdict({ tier: "free", daily: at, monthly: open, estimateCents: 100 }).allow).toBe(true);
    expect(reserveVerdict({ tier: "free", daily: at, monthly: open, estimateCents: 101 }).allow).toBe(false);
  });
});

describe("the message a capped tenant sees", () => {
  test("a free tenant is told it is a free-account limit, and how to lift it", () => {
    const m = cappedMessage({ tier: "free", reason: "monthly", ceilingCents: 1000, resetsOn: "2026-09-01" });
    expect(m).toContain("$10.00");
    expect(m).toContain("free account");
    expect(m).toContain("Anthropic API key");
  });

  // The admin's way out is different, so the sentence must be too — telling the
  // owner to add their own API key would be nonsense.
  test("the admin is pointed at the control that raises it", () => {
    const m = cappedMessage({ tier: "admin", reason: "daily", ceilingCents: 5000, resetsOn: "2026-08-18" });
    expect(m).toContain("Accounts page");
    expect(m).not.toContain("free account");
    expect(m).toContain("today");
  });

  test("reset dates are the next UTC day and the first of the next UTC month", () => {
    const t = new Date("2026-08-17T03:00:00Z");
    expect(resetsOn("daily", t)).toBe("2026-08-18");
    expect(resetsOn("monthly", t)).toBe("2026-09-01");
    expect(resetsOn("daily", new Date("2026-08-31T12:00:00Z"))).toBe("2026-09-01");
    expect(resetsOn("monthly", new Date("2026-12-15T12:00:00Z"))).toBe("2027-01-01");
  });
});
