import { describe, expect, test } from "vitest";
import { shouldReplaceRoleView, shouldUseCachedRoleSearch } from "./role-search-cache";

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

describe("shouldReplaceRoleView", () => {
  test("an error with no payload leaves the current view intact", () => {
    // The regression: findRolesByCriteria's catch and getCachedRoleSearch's
    // error branch both return matches: [] / fetchedAt: null, so applying
    // them blanked cached results the database still holds. Fails against the
    // old unconditional setMatches(res.matches).
    expect(shouldReplaceRoleView({ fetchedAt: null, error: "connection refused" })).toBe(false);
  });

  test("an error that still carries results replaces the view", () => {
    // The cache-write failure path: the billed search succeeded, so the user
    // must see the roles even though the warning banner is showing.
    expect(
      shouldReplaceRoleView({ fetchedAt: "2026-08-13T00:00:00.000Z", error: "cache write failed" })
    ).toBe(true);
  });

  test("a clean result with no cached row yet still replaces the view", () => {
    // Switching families to one that has never been searched must clear the
    // previous family's roles, not leave them on screen under the new label.
    // Fails against a naive `return res.fetchedAt !== null`.
    expect(shouldReplaceRoleView({ fetchedAt: null })).toBe(true);
  });

  test("a clean result with a cached row replaces the view", () => {
    expect(shouldReplaceRoleView({ fetchedAt: "2026-08-13T00:00:00.000Z" })).toBe(true);
  });

  test("an EMPTY error message with no payload ALSO leaves the view intact", () => {
    // The empty-message class, arriving at the one function written to reject
    // exactly this input. `!res.error` is true for "", so a connection-level
    // failure took the success branch and blanked roles the database still
    // holds — the precise outcome the doc comment above says this exists to
    // prevent. getCachedRoleSearch's error branch returns this shape verbatim.
    expect(shouldReplaceRoleView({ fetchedAt: null, error: "" })).toBe(false);
  });

  test("an EMPTY error that still carries a payload replaces the view", () => {
    // Both halves of the rule survive the fix: presence gates the refusal, but
    // a result with a row is still applied so paid-for roles reach the screen.
    expect(shouldReplaceRoleView({ fetchedAt: "2026-08-13T00:00:00.000Z", error: "" })).toBe(
      true
    );
  });
});
