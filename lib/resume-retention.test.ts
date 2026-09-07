import { describe, expect, test } from "vitest";
import {
  RETENTION_DAYS,
  EXPIRED_PREDICATE,
  LIVE_PREDICATE,
  expiresAtFrom,
  isExpired,
} from "./resume-retention";

describe("retention window", () => {
  test("expiry is exactly RETENTION_DAYS after now", () => {
    const now = new Date("2026-09-07T12:00:00.000Z");
    expect(expiresAtFrom(now).toISOString()).toBe("2026-11-06T12:00:00.000Z");
  });

  test("RETENTION_DAYS is 60", () => {
    expect(RETENTION_DAYS).toBe(60);
  });
});

describe("the boundary bites from both sides", () => {
  const now = new Date("2026-09-07T12:00:00.000Z");

  test("a row expiring exactly now IS expired", () => {
    expect(isExpired(new Date(now), now)).toBe(true);
  });

  test("a row expiring one millisecond later is NOT expired", () => {
    expect(isExpired(new Date(now.getTime() + 1), now)).toBe(false);
  });
});

describe("the two SQL predicates are exact complements", () => {
  // This is the test that catches a mutation in SQL a unit test cannot execute.
  // Both predicates are built from one column and one operator pair, so
  // changing either alone makes the pair stop being complementary.
  const COMPLEMENTS: Array<[string, string]> = [
    ["<=", ">"],
    ["<", ">="],
  ];

  function operatorOf(predicate: string): string {
    const m = predicate.match(/expires_at\s*(<=|>=|<|>)\s*now\(\)/);
    if (!m) throw new Error("predicate is not the expected shape: " + predicate);
    return m[1];
  }

  test("expired uses <= and live uses >", () => {
    expect(operatorOf(EXPIRED_PREDICATE)).toBe("<=");
    expect(operatorOf(LIVE_PREDICATE)).toBe(">");
  });

  test("the operators are a complementary pair", () => {
    const expired = operatorOf(EXPIRED_PREDICATE);
    const live = operatorOf(LIVE_PREDICATE);
    const pair = COMPLEMENTS.filter((p) => p[0] === expired && p[1] === live);
    expect(pair.length).toBe(1);
  });

  test("both predicates name the same column", () => {
    expect(EXPIRED_PREDICATE.indexOf("expires_at")).toBeGreaterThanOrEqual(0);
    expect(LIVE_PREDICATE.indexOf("expires_at")).toBeGreaterThanOrEqual(0);
  });

  test("isExpired agrees with EXPIRED_PREDICATE's operator", () => {
    // If someone changes isExpired to `<` without changing the predicate,
    // this fails: the boundary row would be live in JS and purged in SQL.
    const now = new Date("2026-09-07T12:00:00.000Z");
    const boundaryIsExpired = isExpired(new Date(now), now);
    expect(boundaryIsExpired).toBe(operatorOf(EXPIRED_PREDICATE) === "<=");
  });
});
