import { describe, expect, test } from "vitest";
import {
  DEFAULT_CRITERIA,
  MAX_QUERY_MULTIPLIER,
  dateContextLine,
  pickQueries,
  planQueries,
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

  test("returns the input array itself at the equality boundary", () => {
    // toBe, not toEqual: at cap === length the striding formula yields
    // identical CONTENT via the loop path, so only reference identity proves
    // the early return fired. Mutating `<=` to `<` must fail this test.
    const list = ["a", "b", "c"];
    expect(pickQueries(list, 3)).toBe(list);
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

  test("covers every entry in DEFAULT_CRITERIA.locations", () => {
    const queries = titleQueries(DEFAULT_CRITERIA);
    const picked = pickQueries(queries, 15);
    expect(picked.length).toBe(15);
    for (const place of DEFAULT_CRITERIA.locations) {
      expect(picked.some((q) => q.includes(place))).toBe(true);
    }
  });

  test("stack queries: covers every entry in DEFAULT_CRITERIA.stackTerms at cap 15", () => {
    const queries = stackQueries(DEFAULT_CRITERIA);
    const picked = pickQueries(queries, 15);
    expect(picked.length).toBe(15);
    for (const tool of DEFAULT_CRITERIA.stackTerms) {
      expect(picked.some((q) => q.includes(`"${tool}"`))).toBe(true);
    }
  });

  test("a cap of zero or less yields nothing", () => {
    expect(pickQueries(list, 0)).toEqual([]);
    expect(pickQueries(list, -1)).toEqual([]);
  });
});

describe("planQueries", () => {
  const list = Array.from({ length: 39 }, (_, i) => `q${i}`);

  test("no ceiling sends every query and sets max_uses to the multiple", () => {
    const plan = planQueries(list, null);
    expect(plan.queries).toBe(list);
    expect(plan.maxSearches).toBe(39 * MAX_QUERY_MULTIPLIER);
    expect(plan.reason).toContain("no ceiling set");
  });

  test("a ceiling narrows the offer AND becomes the hard cap", () => {
    // Both halves matter: the ceiling has to bind the prompt (how many we
    // offer) and max_uses (how many are billable). A change that applied it
    // to only one of the two would pass a test asserting only the other.
    const plan = planQueries(list, 12);
    expect(plan.queries.length).toBe(12);
    expect(plan.maxSearches).toBe(12);
    expect(plan.reason).toContain("ceiling 12");
  });

  test("a ceiling above the query count cannot inflate the offer", () => {
    const plan = planQueries(list, 500);
    expect(plan.queries.length).toBe(39);
  });

  test("a stored ceiling of 0 reads as 'no ceiling', never as 'zero searches'", () => {
    // The precedence trap this function exists to close. `ceiling ? a : b` is
    // falsy at 0 (sends all 39) while `ceiling ?? c` is NOT nullish at 0
    // (max_uses 0) — inconsistent, and the combination silently returns no
    // results. Whichever way 0 is resolved, the two must agree.
    const plan = planQueries(list, 0);
    expect(plan.queries.length).toBe(39);
    expect(plan.maxSearches).toBe(39 * MAX_QUERY_MULTIPLIER);
  });

  test("a negative stored ceiling reads as 'no ceiling' too", () => {
    const plan = planQueries(list, -5);
    expect(plan.queries.length).toBe(39);
    expect(plan.maxSearches).toBeGreaterThan(0);
  });

  test("max_uses is never zero, even with no queries to send", () => {
    // Every title deleted → an empty enumeration → max_uses 0, which the API
    // rejects outright rather than degrading to "no searches".
    expect(planQueries([], null).maxSearches).toBeGreaterThanOrEqual(1);
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

describe("dateContextLine", () => {
  test("states the supplied date in ISO form", () => {
    expect(dateContextLine(new Date("2026-08-13T12:00:00Z"))).toContain("2026-08-13");
  });

  test("tracks the clock rather than hardcoding a year", () => {
    // The bug this exists to prevent was a hardcoded-feeling year. A literal
    // "2026" in the implementation would pass the test above and fail this one.
    expect(dateContextLine(new Date("2031-01-05T00:00:00Z"))).toContain("2031-01-05");
    expect(dateContextLine(new Date("2031-01-05T00:00:00Z"))).not.toContain("2026");
  });

  test("forbids appending a year, which is the observed failure", () => {
    const line = dateContextLine(new Date("2026-08-13T12:00:00Z"));
    expect(line.toLowerCase()).toContain("do not append a year");
  });
});
