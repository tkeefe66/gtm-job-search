import { describe, expect, test } from "vitest";
import {
  dateContextLine,
  GTM_STACK_TERMS,
  LOCATION_RULE,
  LOCATION_TERMS,
  MAX_QUERIES_PER_SEARCH,
  TARGET_TITLES,
  pickQueries,
  roleExtractionSchema,
  stackQueries,
  titleListForPrompt,
  titleQueries,
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

describe("titleQueries", () => {
  test("produces one query per title and location term", () => {
    expect(titleQueries().length).toBe(TARGET_TITLES.length * LOCATION_TERMS.length);
  });

  test("quotes the title so search engines match the phrase", () => {
    expect(
      titleQueries().some(
        (q) => q.includes('"Revenue Operations"') || q.includes('"Head of Revenue Operations"'),
      ),
    ).toBe(true);
  });

  test("every query carries a location term", () => {
    const queries = titleQueries();
    expect(queries.length).toBe(TARGET_TITLES.length * LOCATION_TERMS.length);
    for (const q of queries) {
      expect(LOCATION_TERMS.some((t) => q.includes(t))).toBe(true);
    }
  });
});

describe("stackQueries", () => {
  test("pairs tool names with hiring language", () => {
    const queries = stackQueries();
    expect(queries.length).toBe(GTM_STACK_TERMS.length * LOCATION_TERMS.length);
    expect(queries.some((q) => q.includes("Clay"))).toBe(true);
    expect(queries.every((q) => q.toLowerCase().includes("hiring"))).toBe(true);
  });

  test("every query carries a location term", () => {
    const queries = stackQueries();
    expect(queries.length).toBe(GTM_STACK_TERMS.length * LOCATION_TERMS.length);
    for (const q of queries) {
      expect(LOCATION_TERMS.some((t) => q.includes(t))).toBe(true);
    }
  });
});

describe("MAX_QUERIES_PER_SEARCH", () => {
  test("is pinned to 15 so changing the cap is a deliberate act", () => {
    expect(MAX_QUERIES_PER_SEARCH).toBe(15);
  });
});

describe("pickQueries", () => {
  test("returns the input unchanged when queries.length <= cap", () => {
    const input = ["a", "b", "c"];
    expect(pickQueries(input, 5)).toEqual(input);
    expect(pickQueries(input, 3)).toEqual(input);
  });

  test("returns exactly cap items when queries.length > cap", () => {
    const input = Array.from({ length: 20 }, (_, i) => `q${i}`);
    expect(pickQueries(input, 7).length).toBe(7);
  });

  test("returns no duplicates", () => {
    const picked = pickQueries(titleQueries());
    expect(new Set(picked).size).toBe(picked.length);
  });

  test("every returned item is a member of the input", () => {
    const input = titleQueries();
    const picked = pickQueries(input);
    for (const q of picked) {
      expect(input.includes(q)).toBe(true);
    }
  });

  test("covers every entry in TARGET_TITLES — this is the assertion that kills slice(0, cap)", () => {
    const picked = pickQueries(titleQueries());
    expect(picked.length).toBe(MAX_QUERIES_PER_SEARCH);
    for (const title of TARGET_TITLES) {
      expect(picked.some((q) => q.includes(`"${title}"`))).toBe(true);
    }
  });

  test("covers every entry in LOCATION_TERMS", () => {
    const picked = pickQueries(titleQueries());
    expect(picked.length).toBe(MAX_QUERIES_PER_SEARCH);
    for (const place of LOCATION_TERMS) {
      expect(picked.some((q) => q.includes(place))).toBe(true);
    }
  });

  test("stack queries: covers every entry in GTM_STACK_TERMS at cap 15", () => {
    const picked = pickQueries(stackQueries());
    expect(picked.length).toBe(MAX_QUERIES_PER_SEARCH);
    for (const tool of GTM_STACK_TERMS) {
      expect(picked.some((q) => q.includes(`"${tool}"`))).toBe(true);
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
