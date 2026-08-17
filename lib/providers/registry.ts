import { createAnthropicProvider } from "./anthropic";
import type { Provider, ProviderId } from "./types";

export class ProviderNotImplementedError extends Error {
  constructor(id: string) {
    super(`No adapter for provider "${id}".`);
    this.name = "ProviderNotImplementedError";
  }
}

/**
 * One instance per provider. The adapters are stateless — key and model arrive
 * per call — so a shared instance cannot leak one tenant's key into another's
 * request, which is the race the old mutated-singleton client had.
 */
const PROVIDERS: Partial<Record<ProviderId, Provider>> = {
  anthropic: createAnthropicProvider(),
};

/**
 * Throws rather than falling back. A stored row naming a provider this build
 * cannot serve is a routing failure; resolving it to Anthropic anyway would
 * send that tenant's key, and their bill, to a vendor they did not choose.
 */
export function providerFor(id: string): Provider {
  const p = PROVIDERS[id as ProviderId];
  if (!p) throw new ProviderNotImplementedError(id);
  return p;
}
