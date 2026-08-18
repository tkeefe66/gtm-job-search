/**
 * Is this tenant's watchlist actually being kept to the interval it asks for?
 *
 * WHY THIS MEASURES THE SYMPTOM RATHER THAN MODELLING THE CAPACITY.
 *
 * The modelled version — tracked companies divided by this tenant's share of
 * platform throughput — needs to know how many tenants exist and how the batch
 * is divided. That is a cross-tenant fact, it is not something a tenant's own
 * page should read, and it would be wrong in exactly the case that matters,
 * because it predicts contention rather than observing it.
 *
 * Overdue-ness is the observation. If companies are consistently missing their
 * schedule, throughput is short, whatever the arithmetic said; if nothing is
 * overdue, the tenant does not need to hear from us. Every input is the tenant's
 * own `watchlist` rows.
 */

export interface TrackedRow {
  trackingEnabled: boolean;
  crawlIntervalDays: number;
  consecutiveFailures: number;
  lastCheckedAt: string | null;
}

export interface CrawlHealth {
  /** Companies with tracking on. */
  tracked: number;
  /** Tracked companies that have missed a whole extra cycle. */
  slipping: number;
  /** Tracked companies deliberately held back by their own failure backoff. */
  failing: number;
  /** Days late of the worst slipping company; 0 when none is. */
  worstDaysLate: number;
  /** Whether the banner should say anything at all. */
  behind: boolean;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The threshold is a MISSED FULL CYCLE — late by more than its own interval
 * again — not "late at all".
 *
 * A crawler that works through a queue is routinely a little late on something;
 * a banner that fires on that is permanent, and a permanent banner is furniture.
 * Late by a whole extra interval cannot be explained by ordinary queueing.
 */
export function summarizeCrawlHealth(
  rows: readonly TrackedRow[],
  now: Date = new Date()
): CrawlHealth {
  const tracked = rows.filter((r) => r.trackingEnabled);

  let slipping = 0;
  let failing = 0;
  let worstDaysLate = 0;

  for (const r of tracked) {
    // Never checked is not slipping: there is no schedule it has fallen behind,
    // it is simply first in line.
    if (r.lastCheckedAt === null) continue;

    // A company whose last check FAILED is not behind because of capacity — it
    // is behind because its careers page is broken, and lib/dead-tracking.ts
    // will stop tracking it once that has held for a week. Counting it as
    // slipping would blame capacity, and the banner's remedy ("track fewer
    // companies") would be wrong advice.
    if (r.consecutiveFailures > 0) {
      failing++;
      continue;
    }

    const dueAt = Date.parse(r.lastCheckedAt) + r.crawlIntervalDays * MS_PER_DAY;
    const daysLate = Math.floor((now.getTime() - dueAt) / MS_PER_DAY);
    if (daysLate > r.crawlIntervalDays) {
      slipping++;
      worstDaysLate = Math.max(worstDaysLate, daysLate);
    }
  }

  return {
    tracked: tracked.length,
    slipping,
    failing,
    worstDaysLate,
    behind: slipping > 0,
  };
}
