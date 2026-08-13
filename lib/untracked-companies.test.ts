import { describe, expect, test } from "vitest";
import { untrackedCompanyNames } from "./untracked-companies";
import type { RoleMatch } from "./types";

function role(company: string): RoleMatch {
  return {
    company,
    role_title: "Head of RevOps",
    job_url: "",
    location: "",
    seniority: "",
    salary_range: "",
    description_summary: "",
    fit_signal: "",
    ic_flag: false,
  };
}

describe("untrackedCompanyNames", () => {
  test("excludes companies already on the watchlist", () => {
    const out = untrackedCompanyNames([role("Clay"), role("Gong")], ["Clay"]);
    expect(out).toEqual(["Gong"]);
  });

  test("matches tracked companies case-insensitively", () => {
    const out = untrackedCompanyNames([role("Clay")], ["clay"]);
    expect(out).toEqual([]);
  });

  test("trims a company name with stray whitespace before returning it", () => {
    // Catches the bug this function was fixed for: comparing on a trimmed
    // key but returning the untrimmed raw string, which then fails
    // groupRolesByCompany's trimmed `untracked.has(company)` lookup.
    const out = untrackedCompanyNames([role("  Clay  ")], []);
    expect(out).toEqual(["Clay"]);
  });

  test("agrees with groupRolesByCompany's trimmed lowercase key for the same input", () => {
    const matches = [role("  Clay  "), role("clay")];
    const out = untrackedCompanyNames(matches, []);
    // Exactly one untracked entry, and it matches what groupRolesByCompany
    // would use as the display key for this same input (first-seen, trimmed).
    expect(out).toEqual(["Clay"]);
  });

  test("dedupes case-insensitively within the match list itself", () => {
    const out = untrackedCompanyNames([role("Clay"), role("CLAY"), role("clay")], []);
    expect(out).toEqual(["Clay"]);
  });

  test("skips matches with an empty or whitespace-only company", () => {
    const out = untrackedCompanyNames([role("  "), role("Clay")], []);
    expect(out).toEqual(["Clay"]);
  });

  test("returns an empty array when every match is already tracked", () => {
    const out = untrackedCompanyNames([role("Clay")], ["Clay"]);
    expect(out).toEqual([]);
    expect(out.length).toBe(0);
  });
});
