// When is a tracked company due for another crawl. The SQL and the pure
// helpers must agree: the SQL drives the cron batch, the helpers drive the
// "next check" display on the Watchlist page.

export const DEFAULT_BATCH_LIMIT = 10;

export const DUE_COMPANIES_SQL = `
  select company,
         careers_url,
         crawl_method,
         crawl_interval_days,
         consecutive_failures,
         last_checked_at
    from watchlist
   where tracking_enabled = true
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
