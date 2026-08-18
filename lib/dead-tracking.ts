/**
 * When a careers page has been dead long enough to stop tracking the company.
 *
 * A dead page is not free. It is crawled on schedule like a healthy one, it
 * consumes a slot in a queue that is shared platform-wide, and it does that
 * forever, because nothing ever gave up. That was invisible at 3 crawls a night
 * and stops being invisible the moment throughput goes up.
 *
 * THIS REPLACED AN EXPONENTIAL BACKOFF, and the reason is worth keeping. Backing
 * off retries a suspect page less and less often — which sounds like the same
 * goal, but it DELAYS the very evidence that proves the page is dead, so a rule
 * of "gone for a week" would fire a fortnight late or later. Retry on the normal
 * schedule, then stop entirely. Simpler, and it means what it says.
 *
 * "Stop tracking" is `tracking_enabled = false`, never a delete. The row holds
 * the careers URL the user may have fixed by hand, its crawl history, and the
 * `crawl_runs` trail; the soft-disable already exists precisely so that survives.
 * The user can turn it straight back on, and the Watchlist says why it went off.
 */

/** How long a page must stay dead. */
export const DEAD_PAGE_GRACE_DAYS = 7;

/**
 * Two failures minimum, whatever the clock says.
 *
 * At a 14-day interval a company that fails once is not retried until day 14, so
 * at day 7 the only evidence is a single failure — as likely a timeout, a 503,
 * or a bot-block as a dead page. Dropping on that untracks a live company for
 * one bad night. The second failure is what turns "something went wrong" into
 * "this page is gone".
 */
export const DEAD_PAGE_MIN_FAILURES = 2;

export interface FailingRow {
  trackingEnabled: boolean;
  consecutiveFailures: number;
  /** When the current unbroken run of failures started; null when healthy. */
  failingSince: string | null;
}

export function shouldStopTracking(row: FailingRow, now: Date = new Date()): boolean {
  // Already off — re-disabling would restamp the row on every crawl and the
  // user could never leave it in the state they chose.
  if (!row.trackingEnabled) return false;
  if (row.failingSince === null) return false;
  if (row.consecutiveFailures < DEAD_PAGE_MIN_FAILURES) return false;

  const deadFor = now.getTime() - Date.parse(row.failingSince);
  // Inclusive: "dead for a week" fires AT a week, not an interval later.
  return deadFor >= DEAD_PAGE_GRACE_DAYS * 24 * 60 * 60 * 1000;
}

/** What the Watchlist tells the user, and what the crawler logs. */
export function stoppedTrackingReason(consecutiveFailures: number): string {
  return (
    `Stopped tracking — the careers page has been unreachable for more than ` +
    `${DEAD_PAGE_GRACE_DAYS} days (${consecutiveFailures} failed checks). ` +
    `Fix the careers URL or turn tracking back on to resume.`
  );
}
