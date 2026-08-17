import { describe, test, expect } from "vitest";
import {
  accessFor,
  sessionVerdict,
  resolveIdentity,
  IDLE_MS,
  ABSOLUTE_MS,
} from "./auth-policy";

const NOW = new Date("2026-08-16T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe("accessFor", () => {
  test("only active gets in", () => {
    expect(accessFor("active")).toEqual({ allow: true });
  });

  test("every other known status is refused with its reason", () => {
    expect(accessFor("pending")).toEqual({ allow: false, reason: "waitlist" });
    expect(accessFor("suspended")).toEqual({ allow: false, reason: "suspended" });
    expect(accessFor("denied")).toEqual({ allow: false, reason: "denied" });
  });

  // The one that matters for a future migration: a status this build has never
  // heard of must not fall through to access.
  test("an unrecognised status fails CLOSED", () => {
    expect(accessFor("trialing")).toEqual({ allow: false, reason: "unknown" });
    expect(accessFor("")).toEqual({ allow: false, reason: "unknown" });
    expect(accessFor("ACTIVE")).toEqual({ allow: false, reason: "unknown" });
  });
});

describe("sessionVerdict", () => {
  test("a fresh, recently-used session is valid", () => {
    expect(
      sessionVerdict({ createdAt: ago(1000), expires: new Date(NOW.getTime() + 1000) }, NOW)
    ).toEqual({ valid: true });
  });

  test("an abandoned session expires on idle", () => {
    expect(
      sessionVerdict({ createdAt: ago(IDLE_MS + 1000), expires: ago(1) }, NOW)
    ).toEqual({ valid: false, reason: "idle" });
  });

  // THE reason this module exists. Auth.js pushes `expires` forward on every
  // request, so a stolen cookie that is actively used keeps renewing itself.
  // Only a cap measured from createdAt stops it.
  test("a CONTINUOUSLY USED session still dies at the absolute cap", () => {
    const v = sessionVerdict(
      {
        createdAt: ago(ABSOLUTE_MS + 1000),
        // expires is far in the future — the attacker's own traffic kept it alive
        expires: new Date(NOW.getTime() + IDLE_MS),
      },
      NOW
    );
    expect(v).toEqual({ valid: false, reason: "absolute" });
  });

  test("the absolute cap outranks a healthy idle window", () => {
    // Both rules consulted; absolute is checked first so the reason is accurate.
    const v = sessionVerdict(
      { createdAt: ago(ABSOLUTE_MS + 1), expires: ago(IDLE_MS + 1) },
      NOW
    );
    expect(v).toEqual({ valid: false, reason: "absolute" });
  });

  test("exactly at the cap is still valid; past it is not", () => {
    const future = new Date(NOW.getTime() + 1000);
    expect(sessionVerdict({ createdAt: ago(ABSOLUTE_MS), expires: future }, NOW)).toEqual({
      valid: true,
    });
    expect(sessionVerdict({ createdAt: ago(ABSOLUTE_MS + 1), expires: future }, NOW)).toEqual({
      valid: false,
      reason: "absolute",
    });
  });
});

describe("resolveIdentity", () => {
  const verified = { sub: "google-123", email: "a@corp.com", emailVerified: true };

  test("an unverified email is refused before anything else is considered", () => {
    expect(
      resolveIdentity({ ...verified, emailVerified: false }, { userId: "u1", googleSub: "google-123" })
    ).toEqual({ kind: "unverified-email" });
  });

  test("no existing row is a new user", () => {
    expect(resolveIdentity(verified, null)).toEqual({ kind: "new-user" });
  });

  test("a matching sub is the known user", () => {
    expect(resolveIdentity(verified, { userId: "u1", googleSub: "google-123" })).toEqual({
      kind: "known-user",
      userId: "u1",
    });
  });

  // The account-takeover path. Alice leaves; Corp reassigns alice@corp.com to a
  // new hire. Same email, different Google sub. Keyed on email, the new hire
  // inherits Alice's pipeline, fit brain, comp floor and stored API key.
  test("same email, DIFFERENT sub is a collision — never the existing user", () => {
    expect(
      resolveIdentity({ ...verified, sub: "google-999" }, { userId: "u1", googleSub: "google-123" })
    ).toEqual({ kind: "sub-collision", existingUserId: "u1" });
  });

  // The seeded admin row has no sub until the first real sign-in claims it.
  test("a row with no recorded sub is claimable once", () => {
    expect(resolveIdentity(verified, { userId: "admin", googleSub: null })).toEqual({
      kind: "known-user",
      userId: "admin",
    });
  });

  test("a claimed row is no longer claimable by a different sub", () => {
    const claimed = { userId: "admin", googleSub: "google-123" };
    expect(resolveIdentity({ ...verified, sub: "attacker" }, claimed)).toEqual({
      kind: "sub-collision",
      existingUserId: "admin",
    });
  });
});
