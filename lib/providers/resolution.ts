import { providerFor } from "./registry";
import { ANTHROPIC_DEFAULT_MODEL } from "./anthropic-pricing";
import type { ProviderId } from "./types";

export interface StoredKeyRow {
  provider: string;
  model: string | null;
}

export interface ProviderConfig {
  providerId: ProviderId;
  model: string;
}

/**
 * Which provider and model a call should run against.
 *
 * Null means "this row cannot be routed by this build" — a stored provider with
 * no adapter. The caller must treat that exactly like a key that will not open:
 * no usable key. Falling back to Anthropic would send a tenant's OpenAI key to
 * Anthropic, and bill whoever's key resolved instead.
 */
export function resolveProviderConfig(row: StoredKeyRow | null): ProviderConfig | null {
  if (row === null) {
    return { providerId: "anthropic", model: ANTHROPIC_DEFAULT_MODEL };
  }
  try {
    const provider = providerFor(row.provider);
    return { providerId: provider.id, model: row.model ?? provider.defaultModel };
  } catch {
    return null;
  }
}
