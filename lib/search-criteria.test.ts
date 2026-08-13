import { describe, expect, test } from "vitest";
import {
  GTM_STACK_TERMS,
  LOCATION_RULE,
  TARGET_TITLES,
  roleExtractionSchema,
  titleListForPrompt,
} from "./search-criteria";

describe("search criteria", () => {
  test("target titles cover the core GTM systems roles", () => {
    const joined = TARGET_TITLES.join(" | ").toLowerCase();
    expect(joined).toContain("revenue operations");
    expect(joined).toContain("gtm systems");
    expect(joined).toContain("gtm engineer");
    expect(joined).toContain("marketing operations");
  });

  test("titles render as a comma-joined prompt fragment with no trailing comma", () => {
    const rendered = titleListForPrompt();
    expect(rendered).toContain("Revenue Operations");
    expect(rendered.endsWith(",")).toBe(false);
    expect(rendered).not.toContain(",,");
  });

  test("location rule names both the remote and Colorado conditions", () => {
    expect(LOCATION_RULE.toLowerCase()).toContain("remote");
    expect(LOCATION_RULE).toContain("Denver");
    expect(LOCATION_RULE).toContain("Boulder");
  });

  test("stack terms include the GTM tools that identify these roles", () => {
    const joined = GTM_STACK_TERMS.join(" ").toLowerCase();
    expect(joined).toContain("salesforce");
    expect(joined).toContain("clay");
    expect(joined).toContain("gong");
  });

  test("extraction schema names every field the Role type requires", () => {
    const schema = roleExtractionSchema();
    for (const field of [
      "role_title",
      "job_url",
      "location",
      "seniority",
      "salary_range",
      "description_summary",
      "fit_signal",
      "ic_flag",
    ]) {
      expect(schema).toContain(field);
    }
  });
});
