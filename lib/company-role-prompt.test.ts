import { describe, expect, test } from "vitest";
import { buildCompanyRolePrompt } from "./company-role-prompt";
import { DEFAULT_CRITERIA, roleExtractionSchema, titleListForPrompt } from "./search-criteria";
import { DEFAULT_PROFILE } from "./profile";

const D = DEFAULT_PROFILE;

const withDefaults = (company: string, careersUrl: string | null) =>
  buildCompanyRolePrompt({
    company,
    careersUrl,
    criteria: DEFAULT_CRITERIA,
    searchSubject: D.searchSubject,
    persona: D.candidatePersona,
    buildingConcept: D.buildingConcept,
    buildingUpside: D.buildingUpside,
  });

describe("buildCompanyRolePrompt", () => {
  test("reproduces today's sentence EXACTLY, with a careers-page hint", () => {
    const hint = ` Their careers page may be: https://acme.com/careers.`;
    const expected = `Search for open ${D.searchSubject} roles at "Acme".${hint} Look for these titles: ${titleListForPrompt(DEFAULT_CRITERIA)}. Visit each job posting URL if available to extract the full details. IMPORTANT location filter: ${DEFAULT_CRITERIA.locationRule}

${roleExtractionSchema(D.candidatePersona, D.buildingConcept, D.buildingUpside)}

If no qualifying roles are found, return a JSON object: {"roles": [], "message": "explanation"}. Otherwise return ONLY the JSON array.`;
    expect(withDefaults("Acme", "https://acme.com/careers")).toBe(expected);
  });

  test("with no careers URL the hint vanishes and no double space is left", () => {
    const prompt = withDefaults("Acme", null);
    expect(prompt).toContain(`roles at "Acme". Look for these titles:`);
    expect(prompt).not.toContain("  ");
  });

  test("renders every career-specific value it is HANDED, never a default", () => {
    // The phase-2 guard in miniature. A required parameter catches OMISSION,
    // which was phase 1's risk; a site that keeps passing the GTM constant
    // compiles and ships. Only an assertion that a CHANGED value reaches the
    // output can catch that.
    const prompt = buildCompanyRolePrompt({
      company: "Acme",
      careersUrl: null,
      criteria: DEFAULT_CRITERIA,
      searchSubject: "SYNTHETIC SUBJECT",
      persona: "SYNTHETIC PERSONA",
      buildingConcept: "SYNTHETIC CONCEPT",
      buildingUpside: "SYNTHETIC UPSIDE",
    });
    expect(prompt).toContain("SYNTHETIC SUBJECT");
    expect(prompt).toContain("SYNTHETIC PERSONA");
    expect(prompt).toContain("SYNTHETIC CONCEPT");
    expect(prompt).toContain("SYNTHETIC UPSIDE");
    expect(prompt).not.toContain(D.searchSubject);
    expect(prompt).not.toContain(D.candidatePersona);
    expect(prompt).not.toContain(D.buildingConcept);
    expect(prompt).not.toContain(D.buildingUpside);
  });
});
