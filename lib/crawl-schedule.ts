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
          or last_checked_at <= now() - (crawl_interval_days || ' days')::interval)
   order by last_checked_at asc nulls first
   limit $1
`;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function nextCheckDue(
  lastCheckedAt: string | null,
  intervalDays: number
): Date | null {
  if (!lastCheckedAt) return null;
  return new Date(new Date(lastCheckedAt).getTime() + intervalDays * MS_PER_DAY);
}

export function isDue(
  lastCheckedAt: string | null,
  intervalDays: number,
  now: Date = new Date()
): boolean {
  const due = nextCheckDue(lastCheckedAt, intervalDays);
  if (!due) return true;
  return due.getTime() <= now.getTime();
}
