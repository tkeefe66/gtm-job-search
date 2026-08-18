import { describe, expect, test } from "vitest";
import { cachesOnboardingClears } from "./onboarding-caches";

describe("cachesOnboardingClears", () => {
  test("clears every cache the criteria keys it writes would clear", () => {
    // Derived from lib/settings-effects.ts, never hand-listed: a new cache
    // added to CACHES_TO_CLEAR must reach onboarding too, and a hand-copy is
    // how the two drift.
    expect(cachesOnboardingClears()).toEqual(
      expect.arrayContaining(["role_searches", "discovered_roles"])
    );
  });

  test("never clears jobs — that is the user's pipeline, not a cache", () => {
    expect(cachesOnboardingClears()).not.toContain("jobs");
  });
});
