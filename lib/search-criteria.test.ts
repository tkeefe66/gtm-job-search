import { describe, expect, test } from "vitest";
import {
  DEFAULT_CRITERIA,
  MAX_QUERY_MULTIPLIER,
  pickQueries,
  roleExtractionSchema,
  stackQueries,
  titleListForPrompt,
  titleQueries,
  type Criteria,
} from "./search-criteria";

const SMALL: Criteria = {
  titles: ["Head of RevOps", "GTM Engineer"],
  locations: ["Denver", "remote"],
  stackTerms: ["Clay", "Gong"],
  locationRule: "Remote or Colorado only.",
  fitBrain: "A candidate.",
};

describe("DEFAULT_CRITERIA", () => {
  test("target titles cover the core GTM systems roles", () => {
    const joined = DEFAULT_CRITERIA.titles.join(" | ").toLowerCase();
    expect(joined).toContain("revenue operations");
    expect(joined).toContain("gtm systems");
    expect(joined).toContain("gtm engineer");
    expect(joined).toContain("marketing operations");
  });

  test("stack terms include the GTM tools that identify these roles", () => {
    const joined = DEFAULT_CRITERIA.stackTerms.join(" ").toLowerCase();
    expect(joined).toContain("salesforce");
    expect(joined).toContain("clay");
    expect(joined).toContain("gong");
  });

  test("location rule names both the remote and Colorado conditions", () => {
    expect(DEFAULT_CRITERIA.locationRule.toLowerCase()).toContain("remote");
    expect(DEFAULT_CRITERIA.locationRule).toContain("Denver");
    expect(DEFAULT_CRITERIA.locationRule).toContain("Boulder");
  });

  test("every default list is non-empty", () => {
    expect(DEFAULT_CRITERIA.titles.length).toBeGreaterThan(0);
    expect(DEFAULT_CRITERIA.locations.length).toBeGreaterThan(0);
    expect(DEFAULT_CRITERIA.stackTerms.length).toBeGreaterThan(0);
  });

  test("fit brain describes the candidate and names a location preference", () => {
    expect(DEFAULT_CRITERIA.fitBrain.length).toBeGreaterThan(200);
    expect(DEFAULT_CRITERIA.fitBrain).toContain("Denver");
  });
});

describe("titleListForPrompt", () => {
  test("renders the supplied criteria, not the defaults", () => {
    const rendered = titleListForPrompt(SMALL);
    expect(rendered).toBe("Head of RevOps, GTM Engineer");
    expect(rendered).not.toContain("Marketing Operations");
  });

  test("has no trailing or doubled comma", () => {
    const rendered = titleListForPrompt(SMALL);
    expect(rendered.endsWith(",")).toBe(false);
    expect(rendered).not.toContain(",,");
  });
});

describe("titleQueries", () => {
  test("produces one query per title and location from the supplied criteria", () => {
    const queries = titleQueries(SMALL);
    expect(queries.length).toBe(4);
  });

  test("quotes the title so search engines match the phrase", () => {
    expect(titleQueries(SMALL)).toContain('"Head of RevOps" Denver job opening');
  });

  test("every query carries a location term", () => {
    const queries = titleQueries(SMALL);
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) {
      expect(SMALL.locations.some((t) => q.includes(t))).toBe(true);
    }
  });

  test("returns nothing when either list is empty rather than emitting a malformed query", () => {
    expect(titleQueries({ ...SMALL, titles: [] })).toEqual([]);
    expect(titleQueries({ ...SMALL, locations: [] })).toEqual([]);
  });
});

describe("stackQueries", () => {
  test("pairs tool names with hiring language", () => {
    const queries = stackQueries(SMALL);
    expect(queries.length).toBe(4);
    expect(queries.some((q) => q.includes("Clay"))).toBe(true);
    expect(queries.every((q) => q.toLowerCase().includes("hiring"))).toBe(true);
  });

  test("every query carries a location term", () => {
    const queries = stackQueries(SMALL);
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) {
      expect(SMALL.locations.some((t) => q.includes(t))).toBe(true);
    }
  });

  test("returns nothing when either list is empty", () => {
    expect(stackQueries({ ...SMALL, stackTerms: [] })).toEqual([]);
    expect(stackQueries({ ...SMALL, locations: [] })).toEqual([]);
  });
});

describe("pickQueries", () => {
  const list = Array.from({ length: 39 }, (_, i) => `q${i}`);

  test("returns the input unchanged when it is already within the cap", () => {
    expect(pickQueries(list.slice(0, 5), 10)).toEqual(list.slice(0, 5));
  });

  test("returns exactly the cap when the input exceeds it", () => {
    expect(pickQueries(list, 15).length).toBe(15);
  });

  test("returns no duplicates", () => {
    const picked = pickQueries(list, 15);
    expect(new Set(picked).size).toBe(picked.length);
  });

  test("every returned item comes from the input", () => {
    const picked = pickQueries(list, 15);
    expect(picked.length).toBeGreaterThan(0);
    for (const q of picked) expect(list).toContain(q);
  });

  test("spreads across the whole list rather than taking a head slice", () => {
    const picked = pickQueries(list, 15);
    expect(picked).toContain("q0");
    expect(picked.some((q) => list.indexOf(q) > 30)).toBe(true);
    expect(picked).not.toEqual(list.slice(0, 15));
  });

  test("covers every title at the default cap", () => {
    const queries = titleQueries(DEFAULT_CRITERIA);
    const picked = pickQueries(queries, 15);
    for (const title of DEFAULT_CRITERIA.titles) {
      expect(picked.some((q) => q.includes(`"${title}"`))).toBe(true);
    }
  });

  test("a cap of zero or less yields nothing", () => {
    expect(pickQueries(list, 0)).toEqual([]);
    expect(pickQueries(list, -1)).toEqual([]);
  });
});

describe("MAX_QUERY_MULTIPLIER", () => {
  test("is pinned so changing the runaway rail is deliberate", () => {
    expect(MAX_QUERY_MULTIPLIER).toBe(2);
  });
});

describe("roleExtractionSchema", () => {
  test("names every field the Role type requires", () => {
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
