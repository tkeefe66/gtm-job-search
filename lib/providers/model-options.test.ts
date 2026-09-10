import { expect, test } from "vitest";
import { providerFor } from "./registry";
import { resolveProviderConfig } from "./resolution";
import { anthropicCostCents } from "./anthropic-pricing";
import { openaiCostCents } from "./openai-pricing";
import { estimateRunCost, readingCostDollars } from "../cost-estimate";
import { rescoreCostDollars } from "../rescore-progress";

const usage = { inputTokens: 1_000_000, cachedInputTokens: 1_000_000, outputTokens: 1_000_000, searches: 2 };
test("lower-cost models retain their own token and search prices", () => {
  expect(anthropicCostCents(usage, "claude-haiku-4-5-20251001")).toBe(612);
  expect(openaiCostCents(usage, "gpt-4.1-mini")).toBe(215);
});

test.each([
  ["anthropic", "claude-haiku-4-5-20251001"],
  ["openai", "gpt-4.1-mini"],
])("%s accepts and estimates the selected lower-cost model", (provider, model) => {
  const config = resolveProviderConfig({ provider, model });
  expect(config).not.toBeNull();
  expect(config?.model).toBe(model);
  const adapter = providerFor(provider);
  expect(adapter.pricedModels).toContain(model);
  const selected = { provider: adapter.id, model };
  const standard = { provider: adapter.id, model: adapter.defaultModel };
  const grid = { titles: 3, locations: 2, stackTerms: 2, ceiling: null };
  expect(estimateRunCost({ ...grid, ...selected }).dollars).toBeLessThan(estimateRunCost({ ...grid, ...standard }).dollars);
  expect(readingCostDollars(100, selected)).toBeLessThan(readingCostDollars(100, standard));
  expect(rescoreCostDollars(100, selected)).toBeLessThan(rescoreCostDollars(100, standard));
});
