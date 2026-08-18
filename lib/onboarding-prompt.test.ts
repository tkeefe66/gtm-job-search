import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  ONBOARDING_SYSTEM,
  RESUME_MAX_CHARS,
  buildOnboardingPrompt,
  truncateResume,
} from "./onboarding-prompt";
import { FIXTURE_QUESTIONS, FIXTURE_RESUME } from "./__fixtures__/onboarding-prompt-inputs";
import { DEFAULT_PROFILE } from "./profile";

/**
 * Regenerate the fixtures with:
 *
 *   npx tsx -e 'import {writeFileSync} from "node:fs";
 *     import {buildOnboardingPrompt} from "./lib/onboarding-prompt";
 *     import {FIXTURE_QUESTIONS, FIXTURE_RESUME} from "./lib/__fixtures__/onboarding-prompt-inputs";
 *     writeFileSync("lib/__fixtures__/onboarding-prompt.questions.txt", buildOnboardingPrompt(FIXTURE_QUESTIONS));
 *     writeFileSync("lib/__fixtures__/onboarding-prompt.resume.txt", buildOnboardingPrompt(FIXTURE_RESUME));'
 *
 * READ THE RENDERED DIFF in the same commit. Regeneration blesses whatever the
 * code currently emits, so a commit that touches only a fixture is a red flag.
 */
const read = (name: string) =>
  readFileSync(path.join(__dirname, "__fixtures__", name), "utf8");

describe("the rendered onboarding prompt, against its fixture", () => {
  test("the questions path matches onboarding-prompt.questions.txt exactly", () => {
    expect(buildOnboardingPrompt(FIXTURE_QUESTIONS)).toBe(read("onboarding-prompt.questions.txt"));
  });

  test("the résumé path matches onboarding-prompt.resume.txt exactly", () => {
    expect(buildOnboardingPrompt(FIXTURE_RESUME)).toBe(read("onboarding-prompt.resume.txt"));
  });
});

describe("what the prompt asks for", () => {
  test("names every generated profile field, so nothing arrives undefined", () => {
    const prompt = buildOnboardingPrompt(FIXTURE_QUESTIONS);
    for (const key of [
      "fitBrain",
      "weakFitTail",
      "moderateTail",
      "strongTail",
      "titleScope",
      "domainBonus",
      "searchSubject",
      "querySubject",
      "stackFamilyIntro",
      "candidatePersona",
      "buildingConcept",
      "buildingUpside",
      "hiringSignal",
      "toolsAreWeak",
      "titles",
      "locations",
      "stackTerms",
      "locationRule",
    ]) {
      expect(prompt, `${key} is never asked for`).toContain(key);
    }
  });

  test("states the two-word / four-word distinction the two subjects need", () => {
    const prompt = buildOnboardingPrompt(FIXTURE_QUESTIONS);
    expect(prompt).toContain("two or three words");
  });

  test("carries no GTM vocabulary of its own", () => {
    // The generation prompt is the one place a stray example would steer every
    // profile the app ever writes back toward one career.
    const prompt = buildOnboardingPrompt(FIXTURE_RESUME);
    expect(prompt).not.toContain(DEFAULT_PROFILE.searchSubject);
    expect(prompt).not.toContain("RevOps");
    expect(prompt).not.toContain("Salesforce");
    expect(ONBOARDING_SYSTEM).not.toContain("RevOps");
  });

  test("the answers reach the prompt verbatim", () => {
    const prompt = buildOnboardingPrompt(FIXTURE_QUESTIONS);
    expect(prompt).toContain(FIXTURE_QUESTIONS.current);
    expect(prompt).toContain(FIXTURE_QUESTIONS.dealbreakers);
  });

  test("the résumé path sends the résumé and still asks what they want next", () => {
    const prompt = buildOnboardingPrompt(FIXTURE_RESUME);
    expect(prompt).toContain("REGISTERED NURSE");
    // A résumé says where you have BEEN, not where you are going.
    expect(prompt).toContain(FIXTURE_RESUME.wanted);
  });
});

describe("truncateResume", () => {
  test("leaves a normal résumé alone", () => {
    expect(truncateResume("short")).toEqual({ text: "short", truncated: false });
  });

  test("cuts an over-long one and SAYS it cut", () => {
    const long = "x".repeat(RESUME_MAX_CHARS + 1000);
    const out = truncateResume(long);
    expect(out.text.length).toBe(RESUME_MAX_CHARS);
    expect(out.truncated).toBe(true);
  });
});
