import { describe, expect, test } from "vitest";
import { answersAreComplete, cachesOnboardingClears, generationFailure } from "./onboarding-rules";
import { DEFAULT_PROFILE } from "./profile";

describe("answersAreComplete", () => {
  test("the questions path needs what it asks for", () => {
    expect(answersAreComplete({ ...DEFAULT_PROFILE.answers, mode: "questions" })).toBe(false);
    expect(
      answersAreComplete({
        mode: "questions",
        current: "Machinist",
        wanted: "CNC programmer",
        where: "Denver",
        dealbreakers: "",
        resume: "",
      })
    ).toBe(true);
  });

  test("dealbreakers may be empty — 'nothing rules a job out' is an answer", () => {
    expect(
      answersAreComplete({
        mode: "questions",
        current: "Machinist",
        wanted: "CNC programmer",
        where: "Denver",
        dealbreakers: "",
        resume: "",
      })
    ).toBe(true);
  });

  test("the résumé path needs a résumé AND what they want next", () => {
    expect(
      answersAreComplete({
        mode: "resume",
        current: "",
        wanted: "",
        where: "Denver",
        dealbreakers: "",
        resume: "a résumé",
      })
    ).toBe(false);
    expect(
      answersAreComplete({
        mode: "resume",
        current: "",
        wanted: "Charge nurse",
        where: "Denver",
        dealbreakers: "",
        resume: "a résumé",
      })
    ).toBe(true);
  });
});

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

describe("generationFailure", () => {
  test("does not name the database — the failure is Claude or the parse", () => {
    // UNDESCRIBED_DB_ERROR names the database and would be a false sentence
    // here. Same ruling scoreFit's catch follows.
    expect(generationFailure()).not.toMatch(/database/i);
    expect(generationFailure().length).toBeGreaterThan(0);
  });
});
