import { rawQuery } from "@/lib/supabase";
import { isPlatform } from "@/lib/platform-context";
import { requireActor } from "@/lib/require-actor";

/**
 * The tenant whose rows this call should read and write.
 *
 * Two callers, two answers:
 *
 *   - A REQUEST has a session, so the tenant is the signed-in user.
 *   - The CRAWLER has no session. It runs inside the platform context (entered
 *     by the cron route after its CRON_SECRET check) and still has to read
 *     somebody's criteria and write somebody's jobs.
 *
 * **The platform branch is a single-tenant stopgap and must not survive the
 * crawler becoming multi-tenant.** Today it resolves to the admin, because there
 * is exactly one tenant and its rows are the ones the crawler has always been
 * acting on. The correct end state is the cron route iterating tenants and
 * entering a scope per tenant — `loadRunContext()` resolves ONE criteria set per
 * batch precisely because mixing two title lists in a run produces results that
 * cannot be interpreted (see lib/crawler.ts). Until that loop exists, silently
 * picking a tenant here is the honest minimum, and it is wrong the moment a
 * second tenant is approved.
 */
export async function resolveTenantId(): Promise<string> {
  if (isPlatform()) {
    const { data, error } = await rawQuery<{ id: string }>(
      `select id from users where role = 'admin' order by created_at limit 1`
    );
    // Throws rather than returning null. A tenant id that silently comes back
    // empty would turn every scoped query into "where tenant_id is null", which
    // matches nothing and reads as "this tenant has no data" — the silent-empty
    // failure this whole design is built to avoid.
    if (error || !data[0]) {
      throw new Error("resolveTenantId: no admin tenant to act as");
    }
    return data[0].id;
  }
  return (await requireActor()).tenantId;
}
