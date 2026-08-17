import { describe, expect, test } from "vitest";
import { anthropicCostCents, ANTHROPIC_PRICES } from "./anthropic-pricing";

const none = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, searches: 0 };

describe("anthropicCostCents", () => {
  test("prices tokens at the model's own rate, not a shared constant", () => {
    // 1M input at $3 = 300c; 1M output at $15 = 1500c.
    const cents = anthropicCostCents(
      { ...none, inputTokens: 1_000_000, outputTokens: 1_000_000 },
      "claude-sonnet-4-6"
    );
    expect(cents).toBe(1800);
  });

  test("cached input is priced separately and far cheaper than fresh input", () => {
    const fresh = anthropicCostCents({ ...none, inputTokens: 1_000_000 }, "claude-sonnet-4-6");
    const cached = anthropicCostCents({ ...none, cachedInputTokens: 1_000_000 }, "claude-sonnet-4-6");
    expect(fresh).toBe(300);
    expect(cached).toBe(30);
  });

  test("searches are a cent each and are invisible to token usage", () => {
    expect(anthropicCostCents({ ...none, searches: 7 }, "claude-sonnet-4-6")).toBe(7);
  });

  // An unpriced model must not silently cost zero — that reads as a free call
  // and would let a runaway pass every ceiling.
  test("an unknown model falls back to the default model's price rather than zero", () => {
    const known = anthropicCostCents({ ...none, inputTokens: 1_000_000 }, "claude-sonnet-4-6");
    expect(anthropicCostCents({ ...none, inputTokens: 1_000_000 }, "claude-fictional-9")).toBe(known);
  });

  test("the default model is priced", () => {
    expect(ANTHROPIC_PRICES["claude-sonnet-4-6"]).toBeDefined();
  });
});
