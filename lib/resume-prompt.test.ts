import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildThemePrompt, type JobSummaryFields } from "./resume-prompt";
import {
  FIXTURE_JOB_FULL,
  FIXTURE_JOB_SPARSE,
  FIXTURE_VOCABULARY,
} from "./__fixtures__/resume-prompt-inputs";

function fixture(name: string): string {
  return readFileSync(path.join(__dirname, "__fixtures__", name), "utf8");
}

describe("buildThemePrompt", () => {
  test("every job field populated renders byte-identically to the checked-in fixture", () => {
    const { prompt } = buildThemePrompt(FIXTURE_JOB_FULL, FIXTURE_VOCABULARY);
    expect(prompt).toBe(fixture("resume-prompt.full.txt"));
  });

  test("only the two non-nullable fields populated omits every optional block", () => {
    const { prompt } = buildThemePrompt(FIXTURE_JOB_SPARSE, FIXTURE_VOCABULARY);
    expect(prompt).toBe(fixture("resume-prompt.sparse.txt"));
    expect(prompt).not.toContain("Key skills:");
    expect(prompt).not.toContain("Seniority:");
    expect(prompt).not.toContain("Department:");
    expect(prompt).not.toContain("Salary range:");
    expect(prompt).not.toContain("Company description:");
    expect(prompt).not.toContain("Fit summary:");
  });

  test("system prompt renders byte-identically to the checked-in fixture", () => {
    const { system } = buildThemePrompt(FIXTURE_JOB_FULL, FIXTURE_VOCABULARY);
    expect(system).toBe(fixture("resume-prompt.system.txt"));
  });
});

// Step 0 of docs/superpowers/specs/2026-09-07-verifiable-sourcing-design.md.
// The posting's own words never reached this prompt: loadJobForTenant selected
// eight columns and `posting` was not among them, so a role whose JD had been
// read tailored from exactly the same inputs as one where only the title was
// known. Every JD the app held was unused by the feature that needs it most.
describe("the posting's own requirements reach the theme prompt", () => {
  const withJd = (over: Partial<JobSummaryFields> = {}): JobSummaryFields => ({
    ...FIXTURE_JOB_SPARSE,
    requirements: ["10+ years running revenue systems", "SQL and dbt"],
    niceToHaves: ["Python"],
    ...over,
  });

  test("requirements are rendered, verbatim", () => {
    const { prompt } = buildThemePrompt(withJd(), FIXTURE_VOCABULARY);

    expect(prompt).toContain("10+ years running revenue systems");
    expect(prompt).toContain("SQL and dbt");
  });

  // Separate from requirements in the prompt as they are in the row: a
  // nice-to-have does not disqualify, and a theme derived as though it were
  // required would weight the résumé toward something optional.
  test("nice-to-haves are rendered, and labelled as not required", () => {
    const { prompt } = buildThemePrompt(withJd(), FIXTURE_VOCABULARY);

    expect(prompt).toContain("Python");
    expect(prompt.toLowerCase()).toContain("nice");
  });

  // The same optionalLine convention every other field here follows: a row with
  // no JD renders no line rather than an empty label the model reads as "this
  // posting requires nothing".
  test("a role with no JD renders no requirement lines at all", () => {
    const { prompt } = buildThemePrompt(
      { ...FIXTURE_JOB_SPARSE, requirements: [], niceToHaves: [] },
      FIXTURE_VOCABULARY
    );

    expect(prompt).not.toContain("Requirements");
    expect(prompt).not.toContain("Nice to have");
  });

  test("requirements lead, because they are what the posting demands", () => {
    const { prompt } = buildThemePrompt(withJd(), FIXTURE_VOCABULARY);

    expect(prompt.indexOf("10+ years running revenue systems")).toBeLessThan(
      prompt.indexOf("Python")
    );
  });
});
