import type { Usage } from "./types";
// Standard text-only paid-tier prices, before account-level free allowances.
// https://ai.google.dev/gemini-api/docs/pricing (2026-09-09).
// No explicit cache is created, so there is no cache-storage charge.
export const GOOGLE_DEFAULT_MODEL = "gemini-2.5-flash";
export const GOOGLE_PRICED_MODELS: readonly string[] = [GOOGLE_DEFAULT_MODEL];
export function googleCostCents(usage: Usage, model: string): number {
  if (!GOOGLE_PRICED_MODELS.includes(model)) throw new Error("Google model has no verified price.");
  if (usage.searches > 0 && usage.groundedRequests === undefined) throw new Error("Google grounding usage is missing.");
  return Math.ceil((usage.inputTokens * 0.3 + usage.cachedInputTokens * 0.03 + usage.outputTokens * 2.5) / 10000 + (usage.groundedRequests ?? 0) * 3.5);
}
