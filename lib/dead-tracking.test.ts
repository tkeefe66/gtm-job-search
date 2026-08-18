import { describe, expect, test } from "vitest";
import { DEAD_PAGE_GRACE_DAYS, shouldStopTracking, type FailingRow } from "./dead-tracking";

const NOW = new Date("2026-08-17T12:00:00.000Z");

const row = (over: Partial<FailingRow> = {}): FailingRow => ({
  trackingEnabled: true,
  consecutiveFailures: 2,
  failingSince: "2026-08-10T12:00:00.000Z", // exactly 7 days before NOW
  ...over,
});

describe("shouldStopTracking", () => {
  test("a healthy company is left alone", () => {
    expect(shouldStopTracking(row({ consecutiveFailures: 0, failingSince: null }), NOW)).toBe(false);
  });

  test("a company failing for a week is dropped", () => {
    expect(shouldStopTracking(row(), NOW)).toBe(true);
  });

  test("a company failing for less than a week is kept", () => {
    expect(shouldStopTracking(row({ failingSince: "2026-08-14T12:00:00.000Z" }), NOW)).toBe(false);
  });

  // The boundary is inclusive: "dead for a week" should fire AT a week, not a
  // crawl-interval later. A company checked weekly would otherwise wait a
  // fortnight.
  test("exactly the grace period is enough", () => {
    const since = new Date(NOW.getTime() - DEAD_PAGE_GRACE_DAYS * 86_400_000);
    expect(shouldStopTracking(row({ failingSince: since.toISOString() }), NOW)).toBe(true);
  });

  // THE GUARD THAT MATTERS. With a 14-day interval, a company that fails once
  // is not retried until day 14 — so at day 7 the only evidence is a single
  // failure, which is as likely to be a timeout or a 503 as a dead page.
  // Dropping on that would untrack a live company for one bad night.
  test("one failure is never enough, however long ago it was", () => {
    expect(
      shouldStopTracking(
        row({ consecutiveFailures: 1, failingSince: "2020-01-01T00:00:00.000Z" }),
        NOW
      )
    ).toBe(false);
  });

  test("a second failure confirms it, and then the clock counts", () => {
    expect(shouldStopTracking(row({ consecutiveFailures: 2 }), NOW)).toBe(true);
  });

  test("no failure timestamp means nothing to measure", () => {
    expect(shouldStopTracking(row({ failingSince: null }), NOW)).toBe(false);
  });

  // Already off. Re-disabling would rewrite the row and restamp it every crawl,
  // and the user could never leave it in the state they chose.
  test("a company the user already stopped tracking is not touched", () => {
    expect(shouldStopTracking(row({ trackingEnabled: false }), NOW)).toBe(false);
  });
});
