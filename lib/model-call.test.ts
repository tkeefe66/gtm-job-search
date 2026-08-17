import { describe, expect, test, vi, beforeEach } from "vitest";
import { runWithBilling } from "./billing-context";

const complete = vi.fn();
const searchAndComplete = vi.fn();
let enforcement: "in-request" | "none" = "in-request";

vi.mock("./providers/registry", () => ({
  providerFor: () => ({
    id: "anthropic",
    defaultModel: "claude-sonnet-4-6",
    get searchCapEnforcement() { return enforcement; },
    complete,
    searchAndComplete,
    costCents: () => 0,
    validateKey: async () => ({ ok: true }),
  }),
}));

import { callWithWebSearch, complete as completeCall, SearchUnavailableError } from "./model-call";

// cachedInputTokens is deliberately NON-ZERO: it is priced separately from
// fresh input, and a zero fixture cannot tell "carried through" apart from
// "never set".
const usage = { inputTokens: 10, cachedInputTokens: 40, outputTokens: 5, searches: 2 };

function scope(over: Partial<Parameters<typeof runWithBilling>[0]> = {}) {
  return {
    maxSearches: null, apiKey: "sk-ant-x", provider: "anthropic" as const,
    model: "claude-sonnet-4-6", searches: 0, inputTokens: 0, cachedInputTokens: 0,
    outputTokens: 0, ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  enforcement = "in-request";
  searchAndComplete.mockResolvedValue({ text: "ok", usage });
  complete.mockResolvedValue({ text: "ok", usage: { ...usage, searches: 0 } });
});

describe("the facade routes through the scope's provider", () => {
  test("the scope's key and model reach the adapter", async () => {
    const s = scope({ model: "claude-opus-4-1", apiKey: "sk-ant-tenant" });
    await runWithBilling(s, () => callWithWebSearch({ system: "s", prompt: "p" }));

    expect(searchAndComplete.mock.calls[0][0]).toMatchObject({
      apiKey: "sk-ant-tenant",
      model: "claude-opus-4-1",
    });
  });

  test("the adapter's usage lands in the scope, cached tokens included", async () => {
    const s = scope();
    await runWithBilling(s, () => callWithWebSearch({ system: "s", prompt: "p" }));

    expect(s.searches).toBe(2);
    expect(s.inputTokens).toBe(10);
    expect(s.cachedInputTokens).toBe(40);
    expect(s.outputTokens).toBe(5);
  });

  test("the budget's cap becomes the request's cap when the caller names none", async () => {
    await runWithBilling(scope({ maxSearches: 6 }), () =>
      callWithWebSearch({ system: "s", prompt: "p" })
    );
    expect(searchAndComplete.mock.calls[0][0].maxSearches).toBe(6);
  });

  test("an explicit cap from the caller still wins — the role-search path computes its own", async () => {
    await runWithBilling(scope({ maxSearches: 6 }), () =>
      callWithWebSearch({ system: "s", prompt: "p", maxSearches: 2 })
    );
    expect(searchAndComplete.mock.calls[0][0].maxSearches).toBe(2);
  });

  test("outside any scope it still runs, on the platform key — cron dry runs and scripts do this", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-platform";
    await callWithWebSearch({ system: "s", prompt: "p" });
    expect(searchAndComplete.mock.calls[0][0].apiKey).toBe("sk-ant-platform");
  });
});

describe("a metered call on a provider that cannot cap in-request", () => {
  test("is refused before the adapter is reached", async () => {
    enforcement = "none";
    await expect(
      runWithBilling(scope({ maxSearches: 6 }), () => callWithWebSearch({ system: "s", prompt: "p" }))
    ).rejects.toBeInstanceOf(SearchUnavailableError);
    expect(searchAndComplete).not.toHaveBeenCalled();
  });

  test("does not affect an uncapped BYO call", async () => {
    enforcement = "none";
    await runWithBilling(scope({ maxSearches: null }), () =>
      callWithWebSearch({ system: "s", prompt: "p" })
    );
    expect(searchAndComplete).toHaveBeenCalled();
  });

  test("does not affect a non-search call", async () => {
    enforcement = "none";
    await runWithBilling(scope({ maxSearches: 6 }), () => completeCall({ system: "s", prompt: "p" }));
    expect(complete).toHaveBeenCalled();
  });
});
