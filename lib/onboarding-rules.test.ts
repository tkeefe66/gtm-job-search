import { describe, expect, test } from "vitest";
import {
  answersAreComplete,
  generationFailure,
  keyStepCopy,
  sampleRoleFor,
} from "./onboarding-rules";
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

describe("generationFailure", () => {
  test("does not name the database — the failure is Claude or the parse", () => {
    // UNDESCRIBED_DB_ERROR names the database and would be a false sentence
    // here. Same ruling scoreFit's catch follows.
    expect(generationFailure()).not.toMatch(/database/i);
    expect(generationFailure().length).toBeGreaterThan(0);
  });
});

describe("keyStepCopy", () => {
  test("does not claim a key is required — an admin can generate without one", () => {
    // resolveTier (lib/budget.ts) gives an admin the platform key regardless
    // of whether one is stored, so any wording implying a key is mandatory,
    // or that there is no free/platform-backed path, is false for that account.
    const copy = keyStepCopy();
    expect(copy).not.toMatch(/entirely on your own/i);
    expect(copy).not.toMatch(/no free tier/i);
    expect(copy).not.toMatch(/must|required|before continuing/i);
  });

  test("tells the user there is a path forward even without a key", () => {
    const copy = keyStepCopy();
    expect(copy.length).toBeGreaterThan(0);
    expect(copy).toMatch(/next step/i);
  });
});

describe("sampleRoleFor", () => {
  test("uses the first non-blank title and location", () => {
    const role = sampleRoleFor({
      titles: ["", "  ", "CNC Programmer", "Machinist"],
      locations: ["", "Denver"],
    });
    expect(role.role_title).toBe("CNC Programmer");
    expect(role.location).toBe("Denver");
  });

  test("falls back to a generic title and an empty location when neither is given", () => {
    const role = sampleRoleFor({ titles: [], locations: [] });
    expect(role.role_title.length).toBeGreaterThan(0);
    expect(role.location).toBe("");
  });

  test("invents nothing beyond title and location — every other field is empty", () => {
    // The whole point of the sample is to sanity-check the fit brain and
    // title scope, not to see how the model reacts to a fabricated company.
    const role = sampleRoleFor({ titles: ["Charge Nurse"], locations: ["Austin"] });
    expect(role.company_description).toBe("");
    expect(role.key_skills).toBe("");
    expect(role.fit_summary).toBe("");
    expect(role.department).toBe("");
    expect(role.salary_range).toBe("");
  });
});
