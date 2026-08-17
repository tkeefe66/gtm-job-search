import type { Usage } from "./types";

/**
 * The ONE Anthropic price table.
 *
 * Deliberately free of any SDK import: lib/cost-estimate.ts reads this and is
 * reached from components/Settings.tsx, a client component. Pulling the SDK in
 * here would drag it into the browser bundle.
 *
 * Dollars per million tokens, as published.
 */
export const ANTHROPIC_PRICES: Record<
  string,
  { input: number; cachedInput: number; output: number }
> = {
  "claude-sonnet-4-6": { input: 3, cachedInput: 0.3, output: 15 },
};

export const ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-4-6";

/** web_search server tool: $10 per 1,000 searches. */
export const ANTHROPIC_CENTS_PER_SEARCH = 1;

/**
 * An unpriced model falls back to the default model's price rather than zero.
 * Zero would read as a free call and let a runaway pass every ceiling — the
 * exact failure the daily cap exists to prevent.
 */
export function anthropicPrice(model: string) {
  return ANTHROPIC_PRICES[model] ?? ANTHROPIC_PRICES[ANTHROPIC_DEFAULT_MODEL];
}

export function anthropicCostCents(usage: Usage, model: string): number {
  const p = anthropicPrice(model);
  const tokenDollars =
    (usage.inputTokens * p.input +
      usage.cachedInputTokens * p.cachedInput +
      usage.outputTokens * p.output) /
    1_000_000;
  return Math.round(tokenDollars * 100) + usage.searches * ANTHROPIC_CENTS_PER_SEARCH;
}
