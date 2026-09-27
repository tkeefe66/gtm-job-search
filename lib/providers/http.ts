import { ProviderRequestError, safeProviderId } from "./errors";
export interface HttpDeps { fetch?: typeof fetch }
/** Never propagate provider bodies, URLs or keys through errors. No automatic
 * retries: retrying a timed-out generation can bill the tenant twice. */
export async function postJson(fetcher: typeof fetch, provider: string, url: string, headers: Record<string, string>, body: unknown): Promise<{ data: Record<string, unknown>; providerRequestId: string | null }> {
  console.log(`${provider}: requesting model response`);
  let response: Response;
  try {
    response = await fetcher(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
  } catch {
    throw new ProviderRequestError(provider);
  }
  const providerRequestId = safeProviderId(response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? response.headers.get("x-goog-request-id"));
  if (!response.ok) {
    console.error(`${provider}: HTTP ${response.status}`);
    // Preserve machine-readable classification without exposing response text.
    let billingBlocked = false;
    try {
      const error = record(record(await response.json()).error);
      billingBlocked = error.code === "insufficient_quota" || error.code === "billing_hard_limit_reached";
    } catch { /* Classification can fall back to HTTP status. */ }
    throw new ProviderRequestError(provider, { status: response.status, providerRequestId, billingBlocked });
  }
  try { return { data: record(await response.json()), providerRequestId }; } catch { throw new ProviderRequestError(provider, { providerRequestId }); }
}
export function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function array(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.map(record) : []; }
export function tokens(value: unknown, optional = false): number {
  if (optional && value === undefined) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Provider returned missing or invalid usage; billing cannot be reconciled.");
  return value;
}
