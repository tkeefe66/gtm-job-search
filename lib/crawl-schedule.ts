// When is a tracked company due for another crawl. The SQL and the pure
// helpers must agree: the SQL drives the cron batch, the helpers drive the
// "next check" display on the Watchlist page.

// Lowered from 10 to 3 (2026-08-12 consolidated fix wave). A search-tier
// crawl is ~60-120s plus per-role URL verification and fit-scoring, so ten
// companies crawled sequentially in one HTTP request is realistically
// 10-20 minutes — the route's now-corrected comment (app/api/cron/crawl/
// route.ts) no longer claims this fits inside a normal HTTP timeout, and it
// doesn't. 3 keeps a batch short until real per-company duration is measured
// against a live database; raise it once that's known.
export const DEFAULT_BATCH_LIMIT = 3;

/**
 * How many times the wait doubles before it stops growing.
 *
 * A company that fails forever must still be retried EVENTUALLY — a careers
 * page comes back, a rename is undone, a 503 ends. A permanent skip would make
 * `consecutive_failures` a death sentence, so the doubling caps here: at a
 * 7-day interval and this many failures the company is retried every 112 days
 * rather than never.
 */
export const MAX_BACKOFF_DOUBLINGS = 4;

/** How many times its own interval a company must wait, given its failure run. */
export function backoffMultiplier(consecutiveFailures: number): number {
  const n = Math.max(0, Math.min(Math.floor(consecutiveFailures), MAX_BACKOFF_DOUBLINGS));
  return 2 ** n;
}

/**
 * `consecutive_failures` was written by the crawler from the beginning and read
 * by nothing, so a careers page that has been dead for a month consumed a slot
 * every interval exactly like a healthy one. At 3 crawls a night that was
 * invisible; it stops being invisible the moment throughput goes up, which is
 * the whole point of the work this ships with.
 *
 * MAX_BACKOFF_DOUBLINGS is interpolated rather than typed in, because a cap
 * hardcoded in this string while the helpers below use the constant is exactly
 * the drift the header comment warns about. A test asserts the interpolation
 * landed.
 */
export const DUE_COMPANIES_SQL = `
  select company,
         careers_url,
         crawl_method,
         crawl_interval_days,
         consecutive_failures,
         last_checked_at
    from watchlist
   where tenant_id = $2
     and tracking_enabled = true
     and (last_checked_at is null
          or last_checked_at <= now() - (
               (crawl_interval_days * power(2, least(consecutive_failures, ${MAX_BACKOFF_DOUBLINGS}))::int)
               || ' days')::interval)
   order by last_checked_at asc nulls first
   limit $1
`;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function nextCheckDue(
  lastCheckedAt: string | null,
  intervalDays: number,
  consecutiveFailures = 0
): Date | null {
  if (!lastCheckedAt) return null;
  const wait = intervalDays * backoffMultiplier(consecutiveFailures) * MS_PER_DAY;
  return new Date(new Date(lastCheckedAt).getTime() + wait);
}

export function isDue(
  lastCheckedAt: string | null,
  intervalDays: number,
  now: Date = new Date(),
  consecutiveFailures = 0
): boolean {
  const due = nextCheckDue(lastCheckedAt, intervalDays, consecutiveFailures);
  if (!due) return true;
  return due.getTime() <= now.getTime();
}

/**
 * Bounds on a per-company crawl interval.
 *
 * Below 1 the interval arithmetic in DUE_COMPANIES_SQL makes a company due on
 * EVERY run, which at 3 crawls a night means one company consumes the whole
 * platform batch and starves every other company and tenant — a per-company
 * setting quietly becoming a platform-wide one. Above 365 it stops being a
 * schedule.
 *
 * Lives here rather than in the action because `"use server"` forbids non-async
 * exports, so a constant declared there cannot be exported OR reached from a
 * test — the same constraint that put buildFitPrompt in lib/.
 */
export const MIN_CRAWL_INTERVAL_DAYS = 1;
export const MAX_CRAWL_INTERVAL_DAYS = 365;

/** The problem with `days`, or "" when it is fine. */
export function crawlIntervalError(days: number): string {
  if (!Number.isInteger(days)) return "Crawl interval must be a whole number of days.";
  if (days < MIN_CRAWL_INTERVAL_DAYS || days > MAX_CRAWL_INTERVAL_DAYS) {
    return `Crawl interval must be between ${MIN_CRAWL_INTERVAL_DAYS} and ${MAX_CRAWL_INTERVAL_DAYS} days.`;
  }
  return "";
}
