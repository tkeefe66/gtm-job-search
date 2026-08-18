import { describe, expect, test } from "vitest";
import { summarizeCrawlHealth, type TrackedRow } from "./crawl-health";

const NOW = new Date("2026-08-17T12:00:00.000Z");

const row = (over: Partial<TrackedRow> = {}): TrackedRow => ({
  trackingEnabled: true,
  crawlIntervalDays: 7,
  consecutiveFailures: 0,
  lastCheckedAt: "2026-08-15T12:00:00.000Z",
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
  // wrong advice, because the backoff already stopped that company competing
  // for slots.
  test("a company held back by its own failure backoff is not blamed on capacity", () => {
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
