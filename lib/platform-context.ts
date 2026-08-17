import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The PLATFORM execution context: work that runs on the app's own behalf, with
 * no signed-in user.
 *
 * Exactly one thing needs it — `app/api/cron/crawl/route.ts`, which
 * authenticates with `CRON_SECRET` and is invoked by the Railway cron service.
 * Its call chain reaches server actions three levels down (crawlCompany →
 * ingestRoles → addJob / updateJob / scoreFit), and those actions require a
 * session. Without this the nightly crawl would throw on every role it tried to
 * save, and — because the route reports per-company outcomes rather than
 * crashing — it would look like a clean run that simply found nothing.
 *
 * The alternative was exempting addJob/updateJob/scoreFit from the session
 * check, which would leave the three actions that write job rows reachable by
 * anyone who read an action id out of the client bundle. Naming the context
 * explicitly keeps the exemption scoped to a call stack rather than to a
 * function.
 *
 * WHY AsyncLocalStorage: it propagates across `await` and `Promise.all`, which
 * the crawl path uses heavily, without threading a parameter through five
 * layers of lib code that have no business knowing about auth.
 *
 * Stored on `globalThis` for the same reason the pg pool is (lib/supabase.ts):
 * Next builds separate react-server and ssr module graphs, so a module-scope
 * `new AsyncLocalStorage()` can be instantiated twice and a value set in one
 * would be invisible to the other.
 */
/**
 * The store carries WHICH tenant the platform is acting for, not merely that it
 * is the platform. `tenantId: null` means platform work with no tenant yet —
 * enumerating who exists — and any tenant-scoped query attempted in that state
 * throws rather than guessing.
 */
type PlatformScope = { tenantId: string | null };

const g = globalThis as unknown as { __platformALS?: AsyncLocalStorage<PlatformScope> };
const store = (g.__platformALS ??= new AsyncLocalStorage<PlatformScope>());

/**
 * Run `fn` as the platform. Call this ONLY after authenticating the caller —
 * in the cron route, that means after the `CRON_SECRET` check, never before.
 */
export function runAsPlatform<T>(fn: () => Promise<T>): Promise<T> {
  return store.run({ tenantId: null }, fn);
}

/**
 * Run `fn` as a SPECIFIC tenant, with no session.
 *
 * This is what the crawler needs. Before it existed, scheduled work resolved to
 * "the admin" — so with a second tenant approved, their tracked companies would
 * never be crawled and any crawl result would land in the admin's pipeline. The
 * cron route now enumerates tenants and enters this scope once per tenant.
 *
 * Nested inside runAsPlatform: the enumeration is platform work, each crawl is
 * tenant work.
 */
export function runAsTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  if (!tenantId) throw new Error("runAsTenant requires a tenant id");
  return store.run({ tenantId }, fn);
}

/** True inside any platform scope, with or without a tenant. */
export function isPlatform(): boolean {
  return store.getStore() !== undefined;
}

/** The tenant the platform is acting for, or null if it has not chosen one. */
export function platformTenantId(): string | null {
  return store.getStore()?.tenantId ?? null;
}
