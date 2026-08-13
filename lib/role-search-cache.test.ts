import { describe, expect, test } from "vitest";
import { shouldUseCachedRoleSearch } from "./role-search-cache";

describe("shouldUseCachedRoleSearch", () => {
  test("a cache row with zero matches still counts as a hit", () => {
    // This is the regression case the fix targets. The old call site checked
    // `cached.matches.length > 0`, which treats a genuine zero-result search
    // as a permanent cache miss and re-runs the full billed query set on
    // every subsequent non-forced call, forever. A real cache row (fetchedAt
    // set) with no matches must still count as a hit.
    //
    // Fails against the old logic: swap this function's body for
    // `return cached.matches.length > 0;` and this assertion flips to false.
    expect(
      shouldUseCachedRoleSearch({ matches: [], fetchedAt: "2026-08-13T00:00:00.000Z" })
    ).toBe(true);
  });

  test("no cache row is a miss, even if matches is non-empty", () => {
    // Guards the other direction: the decision must key off fetchedAt (row
    // presence), not off matches — an implementation that checks
    // `matches.length > 0` instead of `fetchedAt !== null` would return true
    // here when it should return false.
    expect(shouldUseCachedRoleSearch({ matches: [{ role_title: "x" }], fetchedAt: null })).toBe(
      false
    );
  });
});
