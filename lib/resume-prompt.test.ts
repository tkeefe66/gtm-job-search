import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildThemePrompt } from "./resume-prompt";
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
