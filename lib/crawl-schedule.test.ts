import { describe, expect, test } from "vitest";
import { DUE_COMPANIES_SQL, isDue, nextCheckDue } from "./crawl-schedule";

const NOW = new Date("2026-08-12T12:00:00.000Z");

describe("nextCheckDue", () => {
  test("returns null for a company never checked", () => {
    expect(nextCheckDue(null, 7)).toBeNull();
  });

  test("adds the interval to the last check", () => {
    const due = nextCheckDue("2026-08-01T12:00:00.000Z", 7);
    expect(due?.toISOString()).toBe("2026-08-08T12:00:00.000Z");
  });
});

describe("isDue", () => {
  test("a company never checked is due", () => {
    expect(isDue(null, 7, NOW)).toBe(true);
  });

  test("a company checked longer ago than its interval is due", () => {
    expect(isDue("2026-08-01T12:00:00.000Z", 7, NOW)).toBe(true);
  });

  test("a company checked within its interval is not due", () => {
    expect(isDue("2026-08-10T12:00:00.000Z", 7, NOW)).toBe(false);
  });

  test("the boundary is inclusive — exactly one interval ago is due", () => {
    expect(isDue("2026-08-05T12:00:00.000Z", 7, NOW)).toBe(true);
  });
});

describe("DUE_COMPANIES_SQL", () => {
  test("filters to tracked companies only", () => {
    expect(DUE_COMPANIES_SQL).toContain("tracking_enabled = true");
  });

  test("puts never-checked companies first so nothing starves", () => {
    expect(DUE_COMPANIES_SQL.toLowerCase()).toContain("nulls first");
  });

  test("takes its limit from a bound parameter, never interpolation", () => {
    expect(DUE_COMPANIES_SQL).toContain("limit $1");
  });
});
