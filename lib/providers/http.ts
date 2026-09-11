export interface HttpDeps { fetch?: typeof fetch }
/** Never propagate provider bodies, URLs or keys through errors. No automatic
 * retries: retrying a timed-out generation can bill the tenant twice. */
export async function postJson(fetcher: typeof fetch, provider: string, url: string, headers: Record<string, string>, body: unknown): Promise<Record<string, unknown>> {
  console.log(`${provider}: requesting model response`);
  let response: Response;
  try {
    response = await fetcher(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
  } catch {
    throw new Error(`${provider} request timed out or could not connect. Check connectivity and try again.`);
  }
  if (!response.ok) {
    const reason = response.status === 429 ? "rate limit or quota reached. Check provider billing and retry later" : response.status === 401 || response.status === 403 ? "authentication refused. Check your API key and model access" : response.status >= 500 ? "service unavailable. Try again later" : "request refused. Check model access and request settings";
    console.error(`${provider}: HTTP ${response.status}`);
    // Preserve machine-readable classification without exposing response text.
    let billingBlocked = false;
    try {
      const error = record(record(await response.json()).error);
      billingBlocked = error.code === "insufficient_quota" || error.code === "billing_hard_limit_reached";
    } catch { /* Classification can fall back to HTTP status. */ }
    throw Object.assign(new Error(`${provider}: ${reason}.`), {status:response.status,billingBlocked});
  }
  try { return record(await response.json()); } catch { throw new Error(`${provider} returned invalid JSON. Try again.`); }
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
