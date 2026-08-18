import { describe, expect, test } from "vitest";
import { summarizeCrawlHealth, type TrackedRow } from "./crawl-health";

const NOW = new Date("2026-08-17T12:00:00.000Z");

const row = (over: Partial<TrackedRow> = {}): TrackedRow => ({
  trackingEnabled: true,
  crawlIntervalDays: 7,
  consecutiveFailures: 0,
  lastCheckedAt: "2026-08-15T12:00:00.000Z",
  failingSince: null,
  ...over,
});

describe("summarizeCrawlHealth", () => {
  test("nothing tracked, nothing to say", () => {
    const s = summarizeCrawlHealth([], NOW);
    expect(s.tracked).toBe(0);
    expect(s.behind).toBe(false);
  });

  test("everything checked inside its interval is not behind", () => {
    const s = summarizeCrawlHealth([row(), row()], NOW);
    expect(s.tracked).toBe(2);
    expect(s.slipping).toBe(0);
    expect(s.behind).toBe(false);
  });

  // The threshold is a MISSED FULL CYCLE, not "overdue at all". A company one
  // hour past its interval is the normal state of a scheduler that runs in
  // batches; warning on that would make the banner permanent and therefore
  // ignored.
  test("a company barely past its interval is not yet a warning", () => {
    const s = summarizeCrawlHealth(
      [row({ crawlIntervalDays: 7, lastCheckedAt: "2026-08-09T12:00:00.000Z" })],
      NOW
    );
    expect(s.slipping).toBe(0);
    expect(s.behind).toBe(false);
  });

  test("a company that has missed a full extra cycle is slipping", () => {
    // 7-day interval, last checked 15 days ago: one interval late plus a day.
    const s = summarizeCrawlHealth(
      [row({ crawlIntervalDays: 7, lastCheckedAt: "2026-08-02T12:00:00.000Z" })],
      NOW
    );
    expect(s.slipping).toBe(1);
    expect(s.behind).toBe(true);
    expect(s.worstDaysLate).toBe(8);
  });

  test("a company never checked is not counted as slipping", () => {
    // It has no schedule to have slipped from — it is simply first in line.
    const s = summarizeCrawlHealth([row({ lastCheckedAt: null })], NOW);
    expect(s.slipping).toBe(0);
    expect(s.behind).toBe(false);
  });

  test("untracked companies are ignored entirely", () => {
    const s = summarizeCrawlHealth(
      [row({ trackingEnabled: false, lastCheckedAt: "2020-01-01T00:00:00.000Z" })],
      NOW
    );
    expect(s.tracked).toBe(0);
    expect(s.behind).toBe(false);
  });

  // Without this the banner blames capacity for a company whose careers page is
  // simply broken, and the user's remedy — track fewer companies — would be
  // wrong advice. A broken page is dead-tracking's problem, not throughput's.
  test("a company whose checks are failing is not blamed on capacity", () => {
    const s = summarizeCrawlHealth(
      [row({ crawlIntervalDays: 7, consecutiveFailures: 3, lastCheckedAt: "2026-08-02T12:00:00.000Z" })],
      NOW
    );
    expect(s.slipping).toBe(0);
    expect(s.failing).toBe(1);
    expect(s.behind).toBe(false);
  });

  test("the worst offender sets worstDaysLate", () => {
    const s = summarizeCrawlHealth(
      [
        row({ crawlIntervalDays: 7, lastCheckedAt: "2026-08-02T12:00:00.000Z" }),
        row({ crawlIntervalDays: 7, lastCheckedAt: "2026-07-20T12:00:00.000Z" }),
      ],
      NOW
    );
    expect(s.slipping).toBe(2);
    expect(s.worstDaysLate).toBe(21);
  });
});

// Found by looking at the rendered page rather than by a test: a company the
// crawler gives up on lands in the "Not tracked" drawer, which is COLLAPSED by
// default. Telling the user is the entire point of dropping it, so the count has
// to surface above the fold.
describe("companies the crawler gave up on", () => {
  test("none dropped, nothing to announce", () => {
    expect(summarizeCrawlHealth([row()], NOW).dropped).toBe(0);
  });

  test("a row switched off WITH a failure clock was dropped by us", () => {
    const s = summarizeCrawlHealth(
      [row({ trackingEnabled: false, consecutiveFailures: 4, failingSince: "2026-08-01T12:00:00.000Z" })],
      NOW
    );
    expect(s.dropped).toBe(1);
  });

  // setTracking clears failing_since in both directions, so a row the USER
  // switched off carries no clock. Without this the banner would claim we
  // dropped a company the user turned off themselves.
  test("a row the user switched off is not counted", () => {
    const s = summarizeCrawlHealth(
      [row({ trackingEnabled: false, consecutiveFailures: 0, failingSince: null })],
      NOW
    );
    expect(s.dropped).toBe(0);
  });

  test("dropped companies are not also counted as tracked or slipping", () => {
    const s = summarizeCrawlHealth(
      [row({ trackingEnabled: false, consecutiveFailures: 4, failingSince: "2026-07-01T12:00:00.000Z",
             lastCheckedAt: "2026-07-01T12:00:00.000Z" })],
      NOW
    );
    expect(s.tracked).toBe(0);
    expect(s.slipping).toBe(0);
  });
});
