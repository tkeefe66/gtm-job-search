import { describe, expect, test } from "vitest";
import { onboardingRedirect } from "./require-actor";

describe("onboardingRedirect", () => {
  test("active with no stamp goes to /welcome", () => {
    expect(onboardingRedirect({ onboardedAt: null, allowUnonboarded: false })).toBe("/welcome");
  });

  test("active with a stamp passes through", () => {
    expect(
      onboardingRedirect({ onboardedAt: "2026-08-17T00:00:00.000Z", allowUnonboarded: false })
    ).toBeNull();
  });

  test("an opted-out page passes through regardless", () => {
    // /admin. Without this, a bug in onboarding locks the only admin out of the
    // approval screen — the flow holding the door shut on the one person who
    // could open it.
    expect(onboardingRedirect({ onboardedAt: null, allowUnonboarded: true })).toBeNull();
  });

  test("an empty-string stamp is NOT a stamp", () => {
    expect(onboardingRedirect({ onboardedAt: "", allowUnonboarded: false })).toBe("/welcome");
  });
});
