/** Only provider-generated identifiers, never free-form bodies or SDK messages. */
export function safeProviderId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,256}$/.test(value) ? value : null;
}
export interface ProviderMetadata {
  providerRequestId?: string | null;
  providerResponseId?: string | null;
  stopReason?: string | null;
}
export class ProviderUsageUnknownError extends Error {
  readonly outcome = "unknown" as const;
  readonly providerRequestId: string | null;
  readonly providerResponseId: string | null;
  readonly stopReason: string | null;
  constructor(metadata: ProviderMetadata = {}) {
    super("Provider usage is missing or invalid; AI spending is unknown. Check usage before retrying.");
    this.name = "ProviderUsageUnknownError";
    this.providerRequestId = safeProviderId(metadata.providerRequestId);
    this.providerResponseId = safeProviderId(metadata.providerResponseId);
    this.stopReason = safeProviderId(metadata.stopReason);
  }
}
export class ProviderRequestError extends Error {
  readonly outcome: "refused" | "unknown";
  readonly status: number | undefined;
  readonly providerRequestId: string | null;
  readonly billingBlocked: boolean;
  constructor(provider: string, input: { status?: number; providerRequestId?: unknown; billingBlocked?: boolean } = {}) {
    const status = input.status;
    const refused = status !== undefined && [400, 401, 403, 404, 413, 422, 429].includes(status);
    const reason = input.billingBlocked ? "billing allowance exhausted. Add API credits or check your provider billing limit before retrying" : status === 429 ? "rate limit or quota reached. Check provider billing and retry later" : status === 401 || status === 403 ? "authentication refused. Check your API key and model access" : status !== undefined && status >= 500 ? "service unavailable. Check usage before retrying" : refused ? "request refused. Check model access and request settings" : "request timed out, could not connect, or returned an invalid response. Check usage before retrying";
    super(`${provider}: ${reason}.`);
    this.name = "ProviderRequestError";
    this.outcome = refused ? "refused" : "unknown";
    this.status = status;
    this.providerRequestId = safeProviderId(input.providerRequestId);
    this.billingBlocked = input.billingBlocked === true;
  }
}
