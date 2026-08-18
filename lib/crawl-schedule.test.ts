import { describe, expect, test } from "vitest";
import { DUE_COMPANIES_SQL, isDue, nextCheckDue, crawlIntervalError, MIN_CRAWL_INTERVAL_DAYS, MAX_CRAWL_INTERVAL_DAYS, backoffMultiplier, MAX_BACKOFF_DOUBLINGS } from "./crawl-schedule";

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

describe("crawlIntervalError", () => {
  test("accepts the values the picker offers", () => {
    for (const d of [1, 3, 7, 14, 30, 90]) expect(crawlIntervalError(d)).toBe("");
  });

  // Zero or negative makes DUE_COMPANIES_SQL treat the company as due on every
  // run — one company would consume the entire 3-crawl nightly batch and starve
  // everyone else, turning a per-company setting into a platform-wide one.
  test("refuses intervals that would make a company permanently due", () => {
    expect(crawlIntervalError(0)).toContain("between");
    expect(crawlIntervalError(-7)).toContain("between");
  });

  test("refuses non-integers and absurd values", () => {
    expect(crawlIntervalError(1.5)).toContain("whole number");
    expect(crawlIntervalError(NaN)).toContain("whole number");
    expect(crawlIntervalError(400)).toContain("between");
  });

  test("the boundaries themselves are allowed", () => {
    expect(crawlIntervalError(MIN_CRAWL_INTERVAL_DAYS)).toBe("");
    expect(crawlIntervalError(MAX_CRAWL_INTERVAL_DAYS)).toBe("");
  });
});

describe("backoffMultiplier", () => {
  test("a company that has never failed is on its plain interval", () => {
    expect(backoffMultiplier(0)).toBe(1);
  });

  test("each consecutive failure doubles the wait", () => {
    expect(backoffMultiplier(1)).toBe(2);
    expect(backoffMultiplier(2)).toBe(4);
    expect(backoffMultiplier(3)).toBe(8);
  });

  test("the doubling stops, so a dead page is retried eventually rather than never", () => {
    expect(backoffMultiplier(MAX_BACKOFF_DOUBLINGS)).toBe(2 ** MAX_BACKOFF_DOUBLINGS);
    expect(backoffMultiplier(99)).toBe(2 ** MAX_BACKOFF_DOUBLINGS);
  });
});

describe("the backoff in the SQL and the backoff in the helpers agree", () => {
  // CLAUDE.md: "The SQL and the pure helpers must agree: the SQL drives the
  // cron batch, the helpers drive the 'next check' display on the Watchlist
  // page." A cap hardcoded in the SQL string is exactly how they drift.
  test("DUE_COMPANIES_SQL caps the doubling at MAX_BACKOFF_DOUBLINGS", () => {
    expect(DUE_COMPANIES_SQL).toContain(`least(consecutive_failures, ${MAX_BACKOFF_DOUBLINGS})`);
  });

  test("a company failing repeatedly is not due at its plain interval", () => {
    // 7-day interval, checked 8 days ago, 2 consecutive failures -> 28-day
    // effective interval, so it is NOT due.
    expect(isDue("2026-08-04T12:00:00.000Z", 7, NOW, 2)).toBe(false);
    // The same company with no failures IS due.
    expect(isDue("2026-08-04T12:00:00.000Z", 7, NOW, 0)).toBe(true);
  });

  test("nextCheckDue pushes the displayed date out by the same multiplier", () => {
    const due = nextCheckDue("2026-08-01T12:00:00.000Z", 7, 1);
    expect(due?.toISOString()).toBe("2026-08-15T12:00:00.000Z");
  });
});
