import { describe, expect, test } from "vitest";
import { TITLE_FAMILY_INTRO, buildRoleSearchPrompt, familyIntro } from "./role-search-prompt";
import { DEFAULT_CRITERIA, dateContextLine, roleExtractionSchema } from "./search-criteria";
import { DEFAULT_PROFILE } from "./profile";

const D = DEFAULT_PROFILE;
const QUERIES = ['"Head of GTM Systems" Denver job opening', '"Salesforce" revenue operations hiring Denver'];
const NOW = new Date("2026-08-17T12:00:00.000Z");

const withDefaults = (family: "title" | "stack") =>
  buildRoleSearchPrompt({
    family,
    queries: QUERIES,
    criteria: DEFAULT_CRITERIA,
    stackFamilyIntro: D.stackFamilyIntro,
    persona: D.candidatePersona,
    buildingConcept: D.buildingConcept,
    buildingUpside: D.buildingUpside,
    now: NOW,
  });

describe("familyIntro", () => {
  test("the title family's intro is career-agnostic as written and is a constant", () => {
    expect(familyIntro("title", D.stackFamilyIntro)).toBe(TITLE_FAMILY_INTRO);
    expect(TITLE_FAMILY_INTRO).toBe(
      "Search job boards and company careers pages for currently-open roles matching these searches"
    );
  });

  test("the stack family's intro is the whole handed sentence", () => {
    expect(familyIntro("stack", "SYNTHETIC INTRO")).toBe("SYNTHETIC INTRO");
  });
});

describe("buildRoleSearchPrompt", () => {
  test("reproduces today's stack-family prompt EXACTLY", () => {
    const expected = `${D.stackFamilyIntro}:

${QUERIES.map((q) => `- ${q}`).join("\n")}

Run as many of these searches as you can and combine the results. ${dateContextLine(NOW)} Prioritize postings from the last 60 days. ${DEFAULT_CRITERIA.locationRule}

${roleExtractionSchema(D.candidatePersona, D.buildingConcept, D.buildingUpside)}
- company (string, the hiring company name — REQUIRED, never empty)

Return up to 25 roles. Deduplicate identical postings. Return ONLY the JSON array.`;
    expect(withDefaults("stack")).toBe(expected);
  });

  test("the title family differs from the stack family ONLY by its intro", () => {
    const title = withDefaults("title");
    const stack = withDefaults("stack");
    expect(title.replace(TITLE_FAMILY_INTRO, "<INTRO>")).toBe(
      stack.replace(D.stackFamilyIntro, "<INTRO>")
    );
  });

  test("renders every career-specific value it is HANDED, never a default", () => {
    const prompt = buildRoleSearchPrompt({
      family: "stack",
      queries: QUERIES,
      criteria: DEFAULT_CRITERIA,
      stackFamilyIntro: "SYNTHETIC INTRO",
      persona: "SYNTHETIC PERSONA",
      buildingConcept: "SYNTHETIC CONCEPT",
      buildingUpside: "SYNTHETIC UPSIDE",
      now: NOW,
    });
    expect(prompt).toContain("SYNTHETIC INTRO");
    expect(prompt).toContain("SYNTHETIC PERSONA");
    expect(prompt).toContain("SYNTHETIC CONCEPT");
    expect(prompt).toContain("SYNTHETIC UPSIDE");
    expect(prompt).not.toContain(D.stackFamilyIntro);
    expect(prompt).not.toContain(D.candidatePersona);
  });
});
