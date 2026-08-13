import { describe, expect, test } from "vitest";
import { describeTrackOutcome } from "./track-outcome";
import type { CrawlOutcome } from "./crawler";

function outcome(overrides: Partial<CrawlOutcome> = {}): CrawlOutcome {
  return {
    company: "Clay",
    method: null,
    rolesFound: 0,
    newRoles: 0,
    status: "ok",
    ...overrides,
  };
}

describe("describeTrackOutcome", () => {
  test("reports ok for a successful crawl with roles found", () => {
    const display = describeTrackOutcome(outcome({ status: "ok" }));
    expect(display.ok).toBe(true);
    expect(display.message).toBe("Tracking ✓");
  });

  test("reports ok for a genuine zero-result crawl", () => {
    // "empty" is a real outcome (no roles posted right now), not a failure —
    // must not be flagged as needing attention.
    const display = describeTrackOutcome(outcome({ status: "empty" }));
    expect(display.ok).toBe(true);
    expect(display.message).toBe("Tracking ✓");
  });

  test("flags needs_url as needing attention and points at the fix", () => {
    // Catches an implementation that only checks a top-level `error` field
    // (which trackCompanyByName never sets for a crawl failure) and so would
    // fall through to the "ok" branch here.
    const display = describeTrackOutcome(
      outcome({ status: "needs_url", error: 'Could not find a careers page for "Clay".' })
    );
    expect(display.ok).toBe(false);
    expect(display.message).toContain('Could not find a careers page for "Clay".');
    expect(display.message).toContain("Watchlist");
  });

  test("flags error as needing attention, not as a bare failure", () => {
    const display = describeTrackOutcome(outcome({ status: "error", error: "fetch timed out" }));
    expect(display.ok).toBe(false);
    expect(display.message).toContain("fetch timed out");
    // Must read as "tracked, but needs help" — never as "tracking failed" —
    // since the watchlist row was created regardless of crawl outcome.
    expect(display.message).not.toMatch(/failed to track|not tracked/i);
  });

  test("falls back to a generic reason when the outcome has no error text", () => {
    const display = describeTrackOutcome(outcome({ status: "error", error: undefined }));
    expect(display.ok).toBe(false);
    expect(display.message.length).toBeGreaterThan(0);
  });

  test("treats a missing outcome as ok (no false failure signal)", () => {
    const display = describeTrackOutcome(null);
    expect(display.ok).toBe(true);
    expect(display.message).toBe("Tracking ✓");
  });
});
