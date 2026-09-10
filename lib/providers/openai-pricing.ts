import type { Usage } from "./types";
// Standard GPT-4.1 rates and NON-reasoning web_search_preview pricing:
// https://developers.openai.com/api/docs/models/gpt-4.1
// https://developers.openai.com/api/docs/pricing (2026-09-09).
// Preview search content tokens are free; each tool call costs $0.025.
export const OPENAI_DEFAULT_MODEL = "gpt-4.1";
export const OPENAI_PRICED_MODELS: readonly string[] = [OPENAI_DEFAULT_MODEL];
export function openaiCostCents(usage: Usage, model: string): number {
  if (!OPENAI_PRICED_MODELS.includes(model)) throw new Error("OpenAI model has no verified price.");
  return Math.ceil((usage.inputTokens * 2 + usage.cachedInputTokens * 0.5 + usage.outputTokens * 8) / 10000 + usage.searches * 2.5);
}
