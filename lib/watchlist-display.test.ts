import { expect, test } from "vitest";
import { companyCostDisplay, crawlIssueDisplay, crawlOutcomeText, formatAICost } from "./watchlist-display";

const legacyCreditError = '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."},"request_id":"synthetic-request"}';

// Mutation: repeat the old success-sounding policy message without explaining that listings were not read.
test("legacy direct-only deferrals explain the limitation without inventing a source failure", () => {
  const error = "Direct check finished. Choose Deep search to search beyond direct sources.";
  const issue = crawlIssueDisplay("skipped", error);
  expect(issue?.label).toBe("Job listings couldn’t be read");
  expect(issue?.explanation).toContain("couldn’t read listings");
  expect(issue?.explanation).toContain("exact cause wasn’t recorded");
  expect(issue?.explanation).toContain("paid search wasn’t tried");
  expect(issue?.nextStep).toContain("careers URL");
  expect(issue?.nextStep).toContain("5 paid searches");
  expect(crawlOutcomeText({ status: "skipped", rolesFound: 0, newRoles: 0, error })).not.toContain("Direct check finished");
});

// Mutation: prescribe a blind retry for every partial result, including incomplete source coverage.
test("partial checks distinguish unfinished roles, source coverage, and older unknown reasons", () => {
  expect(crawlIssueDisplay("partial", "2 matching roles still need processing. Details were not saved.")?.nextStep).toContain("Check now");
  expect(crawlIssueDisplay("partial", "Only part of the careers page fit within this check's reading limit.")?.nextStep).toContain("job-board URL");
  const legacy = crawlIssueDisplay("partial", "Listings were checked; some processing is incomplete or the search covered only part of the source. Try again or review the saved roles.");
  expect(legacy?.explanation).toContain("Role processing or source coverage was incomplete");
  expect(legacy?.explanation).toContain("didn’t record which");
  expect(legacy?.nextStep).toContain("Check now");
});

// Mutation caught: treating a historical credit refusal as a missing job board or showing raw SDK JSON.
test("explains legacy credit refusals and current billing refusals without asserting today's balance", () => {
  const legacy = crawlIssueDisplay("error", legacyCreditError);
  expect(legacy).toMatchObject({ label: "API credits too low" });
  expect(legacy?.explanation).toContain("last attempt");
  expect(legacy?.nextStep).toContain("billing");
  expect(JSON.stringify(legacy)).not.toContain("synthetic-request");
  expect(crawlOutcomeText({ status: "error", rolesFound: 0, newRoles: 0, error: legacyCreditError })).toContain(legacy!.explanation);
  expect(crawlIssueDisplay("error", "Anthropic: billing allowance exhausted. Add API credits or check your provider billing limit before retrying.")?.label).toBe("API billing blocked");
});

// Mutation caught: summarizing the first failure hides the crawler's appended persistence failure.
test("keeps a failed watchlist write visible alongside a recognized AI failure", () => {
  for (const cause of [legacyCreditError, "Anthropic: billing allowance exhausted. Add API credits or check your provider billing limit before retrying.", "The AI did not finish a usable answer. Please retry."]) {
    const error = `${cause} (also failed to record the crawl on the watchlist: connection refused)`;
    expect(crawlOutcomeText({ status: "error", rolesFound: 0, newRoles: 0, error })).toContain("also failed to record the crawl on the watchlist: connection refused");
    expect(crawlIssueDisplay("error", error)?.explanation).toContain("also failed to record the crawl on the watchlist: connection refused");
  }
});

// Mutation caught: collapsing incomplete AI output into a source failure or losing the partial-result warning.
test("distinguishes unusable AI answers from a missing careers URL", () => {
  const error = "The AI did not finish a usable answer. Please retry.";
  expect(crawlIssueDisplay("error", error)).toMatchObject({ label: "AI response incomplete" });
  expect(crawlIssueDisplay("partial", error)?.label).toBe("Partial · AI response incomplete");
  expect(crawlOutcomeText({ status: "partial", rolesFound: 4, newRoles: 2, error })).toContain("Partial check: 4 roles found, 2 new.");
  expect(crawlIssueDisplay("error", "The search produced too much data to finish. Please retry.")?.label).toBe("AI response incomplete");
  expect(crawlIssueDisplay("needs_url", legacyCreditError)?.label).toBe("Needs a careers URL");
});

// Mutation caught: a blank error disappears, an unknown reason is discarded, or a stale error overrides success.
test("keeps unknown failures explicit and ignores stale errors after successful checks", () => {
  expect(crawlIssueDisplay("error", "")?.label).toBe("Check failed");
  expect(crawlIssueDisplay("error", "")?.explanation).toContain("No reason was recorded");
  expect(crawlIssueDisplay("error", "Could not read the careers page: HTTP 403.")?.explanation).toContain("HTTP 403");
  for (const status of ["ok", "empty", "unchanged"]) expect(crawlIssueDisplay(status, legacyCreditError)).toBeNull();
});

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
