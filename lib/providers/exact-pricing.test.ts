import { expect, test } from "vitest";
import { costMicrousd, pricingSnapshot } from "./exact-pricing";
const zero = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, searches: 0 };
test("exact prices retain sub-cent spend and distinct cache TTLs", () => {
  // Mutation: round each request to cents or price cache writes as fresh input.
  expect(costMicrousd("anthropic", "claude-sonnet-4-6", { ...zero, inputTokens: 1, outputTokens: 1 })).toBe(18);
  expect(costMicrousd("anthropic", "claude-sonnet-4-6", { inputTokens: 100, cachedInputTokens: 100, cacheWrite5mTokens: 100, cacheWrite1hTokens: 100, outputTokens: 100, searches: 2 })).toBe(22805);
});
test("exact pricing preserves provider billing units", () => {
  // Mutation: Google bills query count rather than grounded requests; OpenAI uses Anthropic rates.
  expect(costMicrousd("google", "gemini-2.5-flash", { ...zero, searches: 8, groundedRequests: 1 })).toBe(35000);
  expect(costMicrousd("openai", "gpt-4.1-mini", { ...zero, inputTokens: 100, cachedInputTokens: 100, outputTokens: 100, searches: 2 })).toBe(50210);
});
test("unknown models or malformed usage cannot manufacture exact zero", () => {
  // Mutation: unpriced models use a default rate or invalid usage silently defaults to zero.
  expect(() => costMicrousd("anthropic", "unknown", zero)).toThrow();
  expect(() => costMicrousd("anthropic", "__proto__", zero)).toThrow();
  expect(() => pricingSnapshot("anthropic", "__proto__")).toThrow();
  expect(() => costMicrousd("anthropic", "claude-sonnet-4-6", { ...zero, cacheWrite1hTokens: -1 })).toThrow();
  expect(() => costMicrousd("google", "gemini-2.5-flash", { ...zero, searches: 1 })).toThrow();
  expect(pricingSnapshot("anthropic", "claude-sonnet-4-6")).toMatchObject({ provider: "anthropic", model: "claude-sonnet-4-6", version: expect.any(String), cacheWrite5m: 3.75, cacheWrite1h: 6, searchMicrousd: 10000 });
});
