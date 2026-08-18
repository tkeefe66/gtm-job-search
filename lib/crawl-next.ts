/**
 * Which tenant's company the next single crawl belongs to.
 *
 * WHY THIS IS A CHOICE BETWEEN TENANTS AND NOT A QUERY ACROSS THEM.
 *
 * The obvious implementation is one SQL statement picking the most-overdue row
 * in `watchlist` regardless of tenant. That statement cannot be written. Every
 * tenant-scoped table carries `tenant_isolation`, whose USING clause is
 * `tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`
 * (db/migrations/003_rls.sql), and the app connects as `app_rw`, which is
 * neither superuser nor BYPASSRLS. With no GUC set the comparison is against
 * NULL, so the query returns zero rows — silently, which is the worst available
 * outcome.
 *
 * So the caller asks each tenant separately, inside that tenant's own scope,
 * and this function chooses between the answers in application code. Nothing
 * reads across the boundary; the count of code paths that decide which tenant a
 * request means does NOT go up. The design doc listed a cross-tenant selection
 * query as a risk to be careful with — the risk is avoided rather than managed.
 *
 * The cost is N+1 queries per crawl instead of 1. At 25 tenants that is 25
 * indexed reads against a crawl that takes 60-90 seconds, which is not a cost.
 */

export interface TenantCandidate {
  tenantId: string;
  /** That tenant's most-overdue due company, or null when they have none. */
  company: string | null;
  /** How many of that tenant's companies were checked in the current window. */
  crawlsToday: number;
  /** `last_checked_at` of `company`; null when it has never been checked. */
  lastCheckedAt: string | null;
}

/**
 * Fewest crawls so far wins; ties go to the most overdue company; a company
 * never checked outranks every company that has been; total ties break on
 * tenant id.
 *
 * The first rule is the load-bearing one, and it is what `splitCrawlBatch`'s
 * day-number rotation was for. Selecting purely by "most overdue anywhere" would
 * hand every slot to whichever tenant tracks the most companies, forever, since
 * their oldest row is always older than a smaller tenant's — and nothing would
 * report it, because a watchlist that is never crawled looks exactly like
 * companies that are never hiring.
 *
 * The last rule is not cosmetic. This runs once per crawl, so a tie broken at
 * random makes a stuck tenant impossible to reproduce from the logs.
 */
export function pickNextTenant(
  candidates: readonly TenantCandidate[]
): TenantCandidate | null {
  const withWork = candidates.filter((c) => c.company !== null);
  if (withWork.length === 0) return null;

  // Copy before sorting: this is handed the caller's array and sorting in place
  // would reorder it under them.
  return [...withWork].sort(compareCandidates)[0];
}

function compareCandidates(a: TenantCandidate, b: TenantCandidate): number {
  if (a.crawlsToday !== b.crawlsToday) return a.crawlsToday - b.crawlsToday;

  // nulls first — a company never checked is infinitely overdue.
  if (a.lastCheckedAt === null && b.lastCheckedAt !== null) return -1;
  if (b.lastCheckedAt === null && a.lastCheckedAt !== null) return 1;
  if (a.lastCheckedAt !== null && b.lastCheckedAt !== null) {
    const at = Date.parse(a.lastCheckedAt);
    const bt = Date.parse(b.lastCheckedAt);
    if (at !== bt) return at - bt;
  }

  return a.tenantId < b.tenantId ? -1 : a.tenantId > b.tenantId ? 1 : 0;
}
