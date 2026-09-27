import { expect, test } from "vitest";
import { companyCostDisplay, crawlOutcomeText, formatAICost } from "./watchlist-display";

// Mutation caught: rounding a paid sub-cent call down to a displayed $0.00,
// or coercing missing historical evidence into a free check.
test("distinguishes sub-cent spending, confirmed zero, and unrecorded history", () => {
  expect(formatAICost(3200)).toBe("<$0.01");
  expect(formatAICost(0)).toBe("$0.00");
  expect(formatAICost(null)).toBe("Not recorded");
  expect(formatAICost(undefined)).toBe("Not recorded");
  expect(formatAICost(1_234_500)).toBe("$1.23");
});

test("never presents skipped, partial or failed checks as an empty successful listing", () => {
  expect(crawlOutcomeText({ status: "skipped", rolesFound: 0, newRoles: 0, error: "Paid search is off." })).toBe("Paid search is off.");
  expect(crawlOutcomeText({ status: "partial", rolesFound: 4, newRoles: 2, error: "Limit reached." })).toBe("Partial check: 4 roles found, 2 new. Limit reached.");
  expect(crawlOutcomeText({ status: "error", rolesFound: 0, newRoles: 0, error: "" })).toBe("Check failed. Try again or update the careers page.");
  expect(crawlOutcomeText({ status: "unchanged", rolesFound: 8, newRoles: 0 })).toBe("Source unchanged. No new roles.");
  expect(crawlOutcomeText({ status: "empty", rolesFound: 0, newRoles: 0 })).toBe("No matching roles right now.");
});

test("discloses unknown and pending requests alongside only the measured portion", () => {
  const display = companyCostDisplay({ knownCostMicrousd: 204_500, unknownRequests: 2, inFlightRequests: 1,
    latest: { occurredAt: "2026-09-27T00:00:00Z", costMicrousd: 2000, costComplete: false, status: "partial", newRoles: 1 } });
  expect(display.month).toBe("$0.20 recorded; total incomplete");
  expect(display.latest).toBe("<$0.01 recorded; total incomplete");
  expect(display.uncertainty).toBe("2 requests have unknown cost. 1 request is still running.");
  expect(display.latestResult).toBe("Partial check · 1 new role");
});

test("missing company history is not confused with a month of free checks", () => {
  expect(companyCostDisplay(undefined)).toMatchObject({ month: "Not recorded", latest: "Not recorded", latestResult: null });
  expect(companyCostDisplay({ knownCostMicrousd: 0, unknownRequests: 0, inFlightRequests: 0, latest: null }).month).toBe("$0.00");
});

test("an older incomplete request remains explicitly unknown after the month resets", () => {
  const display = companyCostDisplay({ knownCostMicrousd: null, unknownRequests: 0, inFlightRequests: 0,
    latest: { occurredAt: "2026-08-31T23:59:00Z", costMicrousd: null, costComplete: false, status: "error", newRoles: null } });
  expect(display.month).toBe("Not recorded");
  expect(display.latest).toBe("Unknown; total incomplete");
});
