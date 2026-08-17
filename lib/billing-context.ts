import { AsyncLocalStorage } from "node:async_hooks";

/**
 * What a Claude call costs, collected as it happens.
 *
 * Ambient rather than returned, for the same reason the tenant scope is: there
 * are ten call sites across the actions, the crawler and the ingest path, and
 * threading `{ text, usage, searches }` through all of them would touch every
 * signature between here and each caller — including `scoreFit`, which is
 * reached three levels down inside a `Promise.all`.
 *
 * The collector is a MUTABLE object rather than a value, because the whole point
 * is that a call deep inside `run()` can add to it without returning anything.
 *
 * Stored on `globalThis` for the reason lib/platform-context.ts is: Next builds
 * separate react-server and ssr module graphs, so a module-scope
 * `new AsyncLocalStorage()` can be instantiated twice and a value set in one
 * would be invisible to the other.
 */
export interface BillingScope {
  /** Cap handed to every web_search tool in this scope. null = uncapped (BYO). */
  maxSearches: number | null;
  /** The key these calls bill. */
  apiKey: string;
  /** Accumulated, by the helpers in lib/anthropic.ts. */
  searches: number;
  inputTokens: number;
  outputTokens: number;
}

const g = globalThis as unknown as { __billingALS?: AsyncLocalStorage<BillingScope> };
const store = (g.__billingALS ??= new AsyncLocalStorage<BillingScope>());

export function runWithBilling<T>(scope: BillingScope, fn: () => Promise<T>): Promise<T> {
  return store.run(scope, fn);
}

/**
 * The active scope, or null outside one.
 *
 * Null is a real state and must not be treated as an error: `db/apply-schema`,
 * tests, and one-off scripts call the helpers with no budget in play. What must
 * never happen is a METERED call running outside a scope — that is enforced
 * where the key is resolved, not here.
 */
export function billingScope(): BillingScope | null {
  return store.getStore() ?? null;
}

/** Called by the Anthropic helpers as usage is observed. */
export function recordUsage(u: {
  searches?: number;
  inputTokens?: number;
  outputTokens?: number;
}): void {
  const s = store.getStore();
  if (!s) return;
  s.searches += u.searches ?? 0;
  s.inputTokens += u.inputTokens ?? 0;
  s.outputTokens += u.outputTokens ?? 0;
}
