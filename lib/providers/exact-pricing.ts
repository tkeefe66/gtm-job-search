import { ANTHROPIC_PRICES } from "./anthropic-pricing";
import { OPENAI_PRICES } from "./openai-pricing";
import { GOOGLE_PRICED_MODELS } from "./google-pricing";
import type { ProviderId, Usage } from "./types";
import { ProviderUsageUnknownError } from "./errors";

// Standard synchronous text list rates. No invoice discounts or free allowance.
// Anthropic cache rates: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
// Other provider rates inherit their existing, verified provider price tables.
export const PRICING_VERSION = "standard-text-2026-09-27";
export function pricingSnapshot(provider: ProviderId, model: string) {
  if ((provider === "anthropic" && !Object.prototype.hasOwnProperty.call(ANTHROPIC_PRICES, model)) ||
      (provider === "openai" && !Object.prototype.hasOwnProperty.call(OPENAI_PRICES, model))) {
    throw new Error("No verified price for this model. Choose a supported model in Settings.");
  }
  const rate = provider === "anthropic" ? ANTHROPIC_PRICES[model]
    : provider === "openai" ? OPENAI_PRICES[model]
    : GOOGLE_PRICED_MODELS.includes(model) ? { input: 0.3, cachedInput: 0.03, output: 2.5 } : undefined;
  if (!rate) throw new Error("No verified price for this model. Choose a supported model in Settings.");
  return { provider, model, version: PRICING_VERSION, ...rate,
    cacheWrite5m: provider === "anthropic" ? rate.input * 1.25 : 0,
    cacheWrite1h: provider === "anthropic" ? rate.input * 2 : 0,
    searchMicrousd: provider === "anthropic" ? 10000 : provider === "openai" ? 25000 : 35000,
    searchUnit: provider === "google" ? "grounded-request" : "search",
  };
}
export type PricingSnapshot = ReturnType<typeof pricingSnapshot>;

/** Integer micro-USD, rounded once from integral hundredths of a micro-USD. */
export function costMicrousd(provider: ProviderId, model: string, usage: Usage): number {
  const counts = [usage.inputTokens, usage.cachedInputTokens, usage.outputTokens, usage.searches, usage.cacheWrite5mTokens ?? 0, usage.cacheWrite1hTokens ?? 0, usage.groundedRequests ?? 0];
  if (counts.some(n => !Number.isSafeInteger(n) || n < 0)) throw new ProviderUsageUnknownError();
  if (provider === "google" && usage.searches > 0 && usage.groundedRequests === undefined) throw new ProviderUsageUnknownError();
  if (provider !== "anthropic" && ((usage.cacheWrite5mTokens ?? 0) > 0 || (usage.cacheWrite1hTokens ?? 0) > 0)) throw new ProviderUsageUnknownError();
  const p = pricingSnapshot(provider, model);
  const units = usage.inputTokens * Math.round(p.input * 100)
    + usage.cachedInputTokens * Math.round(p.cachedInput * 100)
    + usage.outputTokens * Math.round(p.output * 100)
    + (usage.cacheWrite5mTokens ?? 0) * Math.round(p.cacheWrite5m * 100)
    + (usage.cacheWrite1hTokens ?? 0) * Math.round(p.cacheWrite1h * 100)
    + (provider === "google" ? usage.groundedRequests ?? 0 : usage.searches) * p.searchMicrousd * 100;
  if (!Number.isSafeInteger(units)) throw new ProviderUsageUnknownError();
  return Math.round(units / 100);
}
