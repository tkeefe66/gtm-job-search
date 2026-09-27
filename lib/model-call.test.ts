import { describe, expect, test, vi, beforeEach } from "vitest";
import { runWithBilling, recordUsage } from "./billing-context";

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

import { callWithWebSearch, complete as completeCall, completeDetailed, SearchUnavailableError } from "./model-call";

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
  searchAndComplete.mockResolvedValue({ text: "ok", usage, stopReason: "end_turn" });
  complete.mockResolvedValue({ text: "ok", usage: { ...usage, searches: 0 }, stopReason: "end_turn" });
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

  test("a stricter explicit cap tightens the ambient cap", async () => {
    await runWithBilling(scope({ maxSearches: 6 }), () =>
      callWithWebSearch({ system: "s", prompt: "p", maxSearches: 2 })
    );
    expect(searchAndComplete.mock.calls[0][0].maxSearches).toBe(2);
  });

  test("a caller cannot raise the ambient budget ceiling", async () => {
    await runWithBilling(scope({ maxSearches: 6 }), () =>
      callWithWebSearch({ system: "s", prompt: "p", maxSearches: 32 })
    );
    expect(searchAndComplete.mock.calls[0][0].maxSearches).toBe(6);
  });

  test("outside any scope it still runs, on the platform key — cron dry runs and scripts do this", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-platform";
    await callWithWebSearch({ system: "s", prompt: "p" });
    expect(searchAndComplete.mock.calls[0][0].apiKey).toBe("sk-ant-platform");
  });
});

describe("a metered call on a provider that cannot cap in-request", () => {
  test("an explicit caller ceiling is refused even on an uncapped BYO account", async () => {
    enforcement = "none";
    await expect(runWithBilling(scope(), () => callWithWebSearch({ system: "s", prompt: "p", maxSearches: 32 }))).rejects.toBeInstanceOf(SearchUnavailableError);
    expect(searchAndComplete).not.toHaveBeenCalled();
  });
  test("is refused before the adapter is reached", async () => {
    enforcement = "none";
    await expect(
      runWithBilling(scope({ maxSearches: 6 }), () => callWithWebSearch({ system: "s", prompt: "p" }))
    ).rejects.toBeInstanceOf(SearchUnavailableError);
    expect(searchAndComplete).not.toHaveBeenCalled();
  });

  test("the default ceiling also applies to BYO calls", async () => {
    enforcement = "none";
    await expect(runWithBilling(scope({ maxSearches: null }), () =>
      callWithWebSearch({ system: "s", prompt: "p" })
    )).rejects.toBeInstanceOf(SearchUnavailableError);
    expect(searchAndComplete).not.toHaveBeenCalled();
  });

  test("does not affect a non-search call", async () => {
    enforcement = "none";
    await runWithBilling(scope({ maxSearches: 6 }), () => completeCall({ system: "s", prompt: "p" }));
    expect(complete).toHaveBeenCalled();
  });
});

describe("completeDetailed", () => {
  test("passes the jsonSchema through and surfaces the provider's stopReason", async () => {
    complete.mockResolvedValue({ text: '{"a":1}', usage: { ...usage, searches: 0 }, stopReason: "max_tokens" });
    const schema = { type: "object" };

    const res = await runWithBilling(scope(), () =>
      completeDetailed({ system: "s", prompt: "p", maxTokens: 2000, jsonSchema: schema })
    );

    expect(complete.mock.calls[0][0]).toMatchObject({ jsonSchema: schema, maxTokens: 2000 });
    expect(res).toEqual({ text: '{"a":1}', stopReason: "max_tokens" });
  });
});


test("all search callers inherit the 50-search default", async () => {
  // Mutation: leave an omitted per-call ceiling uncapped.
  await runWithBilling(scope(), () => callWithWebSearch({ system: "s", prompt: "p" }));
  expect(searchAndComplete.mock.calls[0][0].maxSearches).toBe(50);
});
test("text-only completion refuses incomplete JSON after recording usage", async () => {
  // Mutation: discard stopReason while returning parseable partial output.
  complete.mockResolvedValue({ text: '{"roles":[]}', usage, stopReason: "max_tokens" });
  const s = scope();
  await expect(runWithBilling(s, () => completeCall({ system: "s", prompt: "p" }))).rejects.toThrow();
  expect(s.outputTokens).toBe(usage.outputTokens);
});

test("tracking hook owns usage exactly once before an incomplete answer is rejected", async () => {
  // Mutation: collect records a second usage increment after tracked dispatch.
  complete.mockResolvedValue({ text: "partial", usage, stopReason: "max_tokens" });
  const flush = vi.fn();
  const trackCall = vi.fn(async (_meta, call) => { const result = await call(); recordUsage(result.usage); await flush(); return result; });
  const s = scope({ trackCall, flushUsage: flush });
  await expect(runWithBilling(s, () => completeCall({ system: "s", prompt: "p", maxTokens: 123 }))).rejects.toThrow();
  expect(trackCall).toHaveBeenCalledWith({ kind: "complete", maxTokens: 123 }, expect.any(Function));
  expect(s.inputTokens).toBe(usage.inputTokens);
  expect(flush).toHaveBeenCalledTimes(1);
});
test("search hook receives effective cap and explicit mode before provider dispatch", async () => {
  // Mutation: tracking sees requested rather than effective cap, or filtered mode is dropped.
  const trackCall = vi.fn(async (_meta, call) => { const result = await call(); recordUsage(result.usage); return result; });
  const s = scope({ trackCall, maxSearches: 3 });
  await runWithBilling(s, () => callWithWebSearch({ system: "s", prompt: "p", maxTokens: 123, maxSearches: 5, searchMode: "filtered" }));
  expect(trackCall).toHaveBeenCalledWith({ kind: "search", maxTokens: 123, maxSearches: 3, searchMode: "filtered" }, expect.any(Function));
  expect(searchAndComplete.mock.calls[0][0]).toMatchObject({ maxSearches: 3, searchMode: "filtered" });
  expect(s.searches).toBe(usage.searches);
});

test.each([
  { provider: "anthropic" as const, model: "claude-haiku-4-5-20251001", requested: "filtered" as const, effective: "basic" },
  { provider: "anthropic" as const, model: "claude-sonnet-4-6", requested: undefined, effective: "basic" },
  { provider: "anthropic" as const, model: "claude-sonnet-4-6", requested: "filtered" as const, effective: "filtered" },
  { provider: "openai" as const, model: "gpt-4.1", requested: "filtered" as const, effective: "basic" },
])("search hook records actual $effective mode for $provider/$model requested $requested", async ({provider,model,requested,effective}) => {
  // Mutation: persist requested filtering when the selected adapter/model uses basic search.
  const trackCall = vi.fn(async (_meta, call) => call());
  await runWithBilling(scope({ provider, model, trackCall }), () =>
    callWithWebSearch({ system: "s", prompt: "p", maxSearches: 5, searchMode: requested }));
  expect(trackCall).toHaveBeenCalledWith(expect.objectContaining({ kind: "search", searchMode: effective }), expect.any(Function));
  expect(searchAndComplete).toHaveBeenCalledWith(expect.objectContaining({ searchMode: effective }));
});
