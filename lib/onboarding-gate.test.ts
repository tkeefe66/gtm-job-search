import { describe, expect, test } from "vitest";
import { onboardingRedirect } from "./require-actor";
import type { Actor } from "./require-actor";

const user: Actor = { userId: "u1", tenantId: "u1", email: "a@b.c", isAdmin: false };
const admin: Actor = { ...user, isAdmin: true };

describe("onboardingRedirect", () => {
  test("active with no stamp goes to /welcome", () => {
    expect(onboardingRedirect({ actor: user, onboardedAt: null, allowUnonboarded: false })).toBe(
      "/welcome"
    );
  });

  test("active with a stamp passes through", () => {
    expect(
      onboardingRedirect({ actor: user, onboardedAt: "2026-08-17T00:00:00.000Z", allowUnonboarded: false })
    ).toBeNull();
  });

  test("an opted-out page passes through regardless", () => {
    // /admin. Without this, a bug in onboarding locks the only admin out of the
    // approval screen — the flow holding the door shut on the one person who
    // could open it.
    expect(onboardingRedirect({ actor: admin, onboardedAt: null, allowUnonboarded: true })).toBeNull();
  });

  test("being an admin is NOT by itself an exemption", () => {
    // The admin is the account that would dogfood this flow. Exempting them by
    // role would leave it untested by the only person who can judge its output.
    expect(onboardingRedirect({ actor: admin, onboardedAt: null, allowUnonboarded: false })).toBe(
      "/welcome"
    );
  });

  test("an empty-string stamp is NOT a stamp", () => {
    expect(onboardingRedirect({ actor: user, onboardedAt: "", allowUnonboarded: false })).toBe(
      "/welcome"
    );
  });
});
