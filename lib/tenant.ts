import { isPlatform, platformTenantId } from "@/lib/platform-context";
import { requireActor } from "@/lib/require-actor";

/**
 * The tenant whose rows this call should read and write.
 *
 * Two callers, two answers:
 *
 *   - A REQUEST has a session, so the tenant is the signed-in user.
 *   - The CRAWLER has no session. It runs inside the platform context (entered
 *     by the cron route after its CRON_SECRET check) and must say WHICH tenant
 *     it is acting for, using runAsTenant().
 *
 * The platform branch used to resolve to "the admin", which was a single-tenant
 * stopgap: with a second tenant approved, their companies would never have been
 * crawled and their results would have landed in the admin's pipeline. It now
 * throws instead. `loadRunContext()` resolves ONE criteria set per batch
 * precisely because mixing two title lists in a run produces results that cannot
 * be interpreted (see lib/crawler.ts) — which is the same reason the crawl must
 * be scoped per tenant rather than run once for everyone.
 */
export async function resolveTenantId(): Promise<string> {
  if (isPlatform()) {
    const tenantId = platformTenantId();
    // THROWS rather than picking one. The previous version resolved to "the
    // admin", which silently made every scheduled crawl act as one particular
    // tenant — so a second tenant's companies would never be crawled and their
    // results would land in the admin's pipeline. Guessing here is exactly the
    // failure that produces plausible, wrong data; the caller must say who it
    // is acting for (see runAsTenant in lib/platform-context.ts).
    if (!tenantId) {
      throw new Error(
        "resolveTenantId: platform work touched a tenant-scoped table without " +
          "entering runAsTenant() — refusing to guess which tenant it meant"
      );
    }
    return tenantId;
  }
  return (await requireActor()).tenantId;
}
