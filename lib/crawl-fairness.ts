/**
 * How one nightly crawl budget is divided between tenants.
 *
 * The budget is small and fixed — DEFAULT_BATCH_LIMIT is 3, the loop is
 * sequential, and a search-tier crawl takes 60-120s — so this is not a
 * formality. With N tenants and 3 slots, somebody gets nothing on any given
 * night; the only question is whether it is the same somebody every night.
 */

export interface TenantSlice {
  tenantId: string;
  limit: number;
}

/**
 * Round-robin, ROTATED by `rotation`, so the tenant who misses out changes from
 * run to run.
 *
 * Without the rotation, a plain `slice(0, limit)` starves the same tenants
 * forever: with 3 slots and 5 tenants, tenants 4 and 5 would never be crawled at
 * all, and nothing would report it — their watchlists would simply look like
 * companies that are never hiring.
 *
 * `rotation` is supplied by the caller (the cron route passes a day number)
 * rather than read from a clock here, so the split stays pure and testable.
 */
export function splitCrawlBatch(
  tenantIds: readonly string[],
  limit: number,
  rotation = 0
): TenantSlice[] {
  if (tenantIds.length === 0 || limit <= 0) return [];

  const start = ((rotation % tenantIds.length) + tenantIds.length) % tenantIds.length;
  const counts = new Map<string, number>();

  // One slot at a time rather than limit/N: integer division would hand every
  // tenant 0 as soon as there are more tenants than slots, crawling nobody.
  for (let i = 0; i < limit; i++) {
    const id = tenantIds[(start + i) % tenantIds.length];
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  // Only tenants that actually got a slot. A slice of 0 would send the crawler
  // through a tenant scope to do nothing, costing a settings read per tenant per
  // night for no result.
  return Array.from(counts, ([tenantId, n]) => ({ tenantId, limit: n }));
}
