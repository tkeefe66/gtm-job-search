import { describe, expect, test } from "vitest";
import { groupRolesByCompany } from "./group-by-company";
import type { RoleMatch } from "./types";

function role(company: string, role_title = "Head of RevOps"): RoleMatch {
  return {
    company,
    role_title,
    job_url: "",
    location: "",
    seniority: "",
    salary_range: "",
    description_summary: "",
    fit_signal: "",
    ic_flag: false,
  };
}

describe("groupRolesByCompany", () => {
  test("groups differently-cased company names into one group", () => {
    // Catches the plan's original `byCompany.get(m.company)` keying, which
    // treats "Clay" and "clay" as two different companies and would produce
    // groups.size === 2 here.
    const groups = groupRolesByCompany([role("Clay"), role("clay"), role("CLAY")]);
    expect(groups.size).toBe(1);
    const [[, roles]] = [...groups];
    expect(roles.length).toBe(3);
  });

  test("keeps the first-seen casing as the group's key", () => {
    // Catches an implementation that lowercases the key itself (breaking the
    // "reuse existing row's exact casing" behavior ingestRoles depends on)
    // or that keeps the LAST-seen casing instead of the first.
    const groups = groupRolesByCompany([role("clay"), role("Clay"), role("CLAY")]);
    expect(groups.size).toBe(1);
    expect([...groups.keys()]).toEqual(["clay"]);
  });

  test("trims whitespace before comparing keys", () => {
    // Catches an implementation that keys on the raw untrimmed string, which
    // would treat "Clay" and "Clay " as different companies.
    const groups = groupRolesByCompany([role("Clay"), role("Clay ")]);
    expect(groups.size).toBe(1);
  });

  test("keeps distinct companies in separate groups", () => {
    // Catches a broken implementation that collapses everything into a single
    // group regardless of company (e.g. a constant or missing key).
    const groups = groupRolesByCompany([role("Clay"), role("Gong")]);
    expect(groups.size).toBe(2);
    expect(new Set(groups.keys())).toEqual(new Set(["Clay", "Gong"]));
  });

  test("preserves per-company role order", () => {
    // Catches an implementation that overwrites rather than appends to the
    // group's role list.
    const a = role("Clay", "Head of RevOps");
    const b = role("Clay", "GTM Engineer");
    const groups = groupRolesByCompany([a, b]);
    expect(groups.get("Clay")).toEqual([a, b]);
  });

  test("skips matches with an empty or whitespace-only company", () => {
    // Catches an implementation that doesn't guard against a blank company,
    // which would otherwise produce a bogus "" group.
    const groups = groupRolesByCompany([role("  "), role("Clay")]);
    expect(groups.size).toBe(1);
    expect(groups.has("")).toBe(false);
  });
});
