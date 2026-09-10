import type { Usage } from "./types";
// Standard GPT-4.1 rates and NON-reasoning web_search_preview pricing:
// https://developers.openai.com/api/docs/models/gpt-4.1
// https://developers.openai.com/api/docs/pricing (2026-09-09).
// Preview search content tokens are free; each tool call costs $0.025.
export const OPENAI_DEFAULT_MODEL = "gpt-4.1";
export const OPENAI_PRICES: Record<string, { input: number; cachedInput: number; output: number }> = {
  "gpt-4.1": { input: 2, cachedInput: 0.5, output: 8 },
  "gpt-4.1-mini": { input: 0.4, cachedInput: 0.1, output: 1.6 },
};
export const OPENAI_PRICED_MODELS: readonly string[] = Object.keys(OPENAI_PRICES);
export function openaiCostCents(usage: Usage, model: string): number {
  if (!OPENAI_PRICED_MODELS.includes(model)) throw new Error("OpenAI model has no verified price.");
  const price = OPENAI_PRICES[model];
  return Math.ceil((usage.inputTokens * price.input + usage.cachedInputTokens * price.cachedInput + usage.outputTokens * price.output) / 10000 + usage.searches * 2.5);
}
