import { describe, expect, test } from "vitest";
import { roleAge } from "./role-age";

const NOW = new Date("2026-08-14T22:00:00Z");
const daysAgo = (n: number, hours = 0) =>
  new Date(NOW.getTime() - n * 86_400_000 - hours * 3_600_000).toISOString();

const label = (iso: string | null | undefined) => roleAge(iso, NOW)?.label;
const age = (iso: string | null | undefined) => roleAge(iso, NOW)?.age;

describe("roleAge label", () => {
  test("same day reads as today", () => {
    expect(label(daysAgo(0, 3))).toBe("today");
  });

  test("one day is yesterday, not 1d ago", () => {
    expect(label(daysAgo(1))).toBe("yesterday");
  });

  test("days up to the two-week mark stay in days", () => {
    expect(label(daysAgo(2))).toBe("2d ago");
    expect(label(daysAgo(13))).toBe("13d ago");
  });

  test("two weeks flips to weeks", () => {
    expect(label(daysAgo(14))).toBe("2w ago");
    expect(label(daysAgo(59))).toBe("8w ago");
  });

  test("two months flips to months", () => {
    expect(label(daysAgo(60))).toBe("2mo ago");
    expect(label(daysAgo(364))).toBe("12mo ago");
  });

  test("a year flips to years", () => {
    expect(label(daysAgo(365))).toBe("1y ago");
    expect(label(daysAgo(800))).toBe("2y ago");
  });

  test("a future stamp reads as today rather than negative", () => {
    // Clock skew between the Postgres default and the browser is real; the
    // label must never render "-1d ago".
    const future = new Date(NOW.getTime() + 5 * 3_600_000).toISOString();
    expect(label(future)).toBe("today");
    expect(roleAge(future, NOW)?.days).toBe(0);
  });
});

describe("roleAge compact age", () => {
  test("drops the 'ago' and spells yesterday as a day, for the row pill", () => {
    expect(age(daysAgo(0))).toBe("today");
    expect(age(daysAgo(1))).toBe("1d");
    expect(age(daysAgo(30))).toBe("4w");
    expect(age(daysAgo(200))).toBe("6mo");
    expect(age(daysAgo(400))).toBe("1y");
  });
});

describe("roleAge date", () => {
  test("omits the year within the current year", () => {
    // Every row would otherwise repeat ", 2026" down the whole list.
    expect(roleAge("2026-08-03T15:00:00Z", NOW)?.date).toBe("Aug 3");
  });

  test("keeps the year once it differs from now", () => {
    expect(roleAge("2025-12-04T15:00:00Z", NOW)?.date).toBe("Dec 4, 2025");
  });

  test("full always carries the year, whatever date does", () => {
    expect(roleAge("2026-08-03T15:00:00Z", NOW)?.full).toBe("Aug 3, 2026");
    expect(roleAge("2025-12-04T15:00:00Z", NOW)?.full).toBe("Dec 4, 2025");
  });
});

describe("roleAge absence", () => {
  test("a missing stamp renders nothing", () => {
    expect(roleAge(null, NOW)).toBeNull();
    expect(roleAge(undefined, NOW)).toBeNull();
    expect(roleAge("", NOW)).toBeNull();
  });

  test("an unparseable stamp renders nothing rather than NaN", () => {
    expect(roleAge("not a date", NOW)).toBeNull();
  });
});

describe("roleAge tooltip", () => {
  test("spells out the full date even when the pill abbreviates it", () => {
    expect(roleAge("2026-08-03T15:00:00Z", NOW)?.title).toBe("Found Aug 3, 2026");
  });
});
