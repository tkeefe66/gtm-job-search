import { describe, expect, test, vi } from "vitest";
import { createAnthropicProvider } from "./anthropic";
import { createOpenAIProvider } from "./openai";
import { createGoogleProvider } from "./google";

const opts = { apiKey: "synthetic-key", model: "claude-sonnet-4-6", system: "s", prompt: "p", maxTokens: 1000 };
// Composed from the documented Messages envelope, not a paid live capture.
function response(usage: unknown) {
  return { id: "msg_synthetic", content: [
    { type: "server_tool_use", name: "web_search", input: { query: "direct" } },
    { type: "server_tool_use", name: "web_search", caller: { type: "code_execution_20260120", tool_id: "nested" }, input: { query: "nested" } },
    { type: "text", text: "done" },
  ], usage, stop_reason: "end_turn" };
}
function provider(raw: unknown) {
  const create = vi.fn().mockResolvedValue(raw);
  return { p: createAnthropicProvider({ createClient: () => ({ messages: { create } }) }), create };
}

describe("authoritative provider accounting", () => {
  test.each([0, 7])("provider reports %i searches while content shows two", async searches => {
    // Mutation: count visible/direct/nested tool blocks or replace authoritative zero by fallback.
    const { p } = provider(response({ input_tokens: 10, output_tokens: 5, server_tool_use: { web_search_requests: searches } }));
    expect((await p.searchAndComplete(opts)).usage.searches).toBe(searches);
  });
  test.each([undefined, {}, { input_tokens: -1, output_tokens: 5 }, { input_tokens: 10, output_tokens: 1.5 }, { input_tokens: 10, output_tokens: 5, server_tool_use: {} }, { input_tokens: 10, output_tokens: 5, server_tool_use: { web_search_requests: -1 } }])("missing or invalid search usage stays unknown %#", async usage => {
    // Mutation: missing usage defaults to zero or malformed counts reach completed ledger state.
    await expect(provider(response(usage)).p.searchAndComplete(opts)).rejects.toMatchObject({ name: "ProviderUsageUnknownError", outcome: "unknown", providerResponseId: "msg_synthetic" });
  });
  test("cache writes retain TTL and are excluded from fresh input", async () => {
    // Mutation: cache creation is folded into fresh input or all writes get the 5m rate.
    const { p } = provider(response({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 50, cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 30 } }));
    expect((await p.complete(opts)).usage).toEqual({ inputTokens: 10, outputTokens: 5, cachedInputTokens: 7, cacheWrite5mTokens: 20, cacheWrite1hTokens: 30, searches: 0 });
  });
  test("cache totals with missing TTL breakdown cannot claim exact cost", async () => {
    // Mutation: assume every cache write uses 5m without evidence.
    const { p } = provider(response({ input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 50 }));
    await expect(p.complete(opts)).rejects.toMatchObject({ outcome: "unknown" });
  });
  test("a malformed cache TTL is not silently coerced to zero", async () => {
    // Mutation: ignore cache TTL detail when total writes are absent or zero.
    const { p } = provider(response({ input_tokens: 10, output_tokens: 5, cache_creation: { ephemeral_1h_input_tokens: "0" } }));
    await expect(p.complete(opts)).rejects.toMatchObject({ outcome: "unknown" });
  });
  test("HTTP request ID is distinct from response ID and retries are disabled", async () => {
    // Mutation: store message.id as request ID or leave SDK retries implicit.
    const create = vi.fn((_body: unknown, _options?: { timeout: number; maxRetries: number }) => Object.assign(Promise.resolve(response({ input_tokens: 10, output_tokens: 5 })), {
      withResponse: async () => ({ data: response({ input_tokens: 10, output_tokens: 5 }), response: new Response(null, { headers: { "request-id": "req_synthetic" } }) }),
    }));
    const p = createAnthropicProvider({ createClient: () => ({ messages: { create } }) });
    const result = await p.complete(opts);
    expect(result).toMatchObject({ providerRequestId: "req_synthetic", providerResponseId: "msg_synthetic", usageSource: "provider" });
    expect(create.mock.calls[0][1]).toMatchObject({ maxRetries: 0 });
  });
  test.each(["claude-sonnet-4-6", "claude-haiku-4-5-20251001"])("filtered search preserves cap for %s", async model => {
    // Mutation: filtered requests drop max_uses or enable filtering on unsupported Haiku.
    const { p, create } = provider(response({ input_tokens: 10, output_tokens: 5, server_tool_use: { web_search_requests: 1 } }));
    await p.searchAndComplete({ ...opts, model, maxSearches: 5, searchMode: "filtered" });
    expect(create.mock.calls[0][0].tools).toEqual([{ type: model === "claude-sonnet-4-6" ? "web_search_20260209" : "web_search_20250305", name: "web_search", max_uses: 5 }]);
    expect(create.mock.calls[0][1]).toMatchObject({ maxRetries: 0 });
  });
  test("pause_turn returns usage once without hidden continuation", async () => {
    // Mutation: automatically continue a server-tool pause and spend a second request.
    const { p, create } = provider({ ...response({ input_tokens: 10, output_tokens: 5, server_tool_use: { web_search_requests: 3 } }), stop_reason: "pause_turn" });
    expect(await p.searchAndComplete(opts)).toMatchObject({ stopReason: "pause_turn", usage: { searches: 3 } });
    expect(create).toHaveBeenCalledTimes(1);
  });
  test("SDK failures retain safe classification without raw body or key", async () => {
    // Mutation: propagate raw SDK error bodies or mistake an ambiguous 500 for a free refusal.
    const create = vi.fn().mockRejectedValue(Object.assign(new Error("secret sk-ant-do-not-retain"), { status: 500, request_id: "req_failed", error: { secret: "body" } }));
    const p = createAnthropicProvider({ createClient: () => ({ messages: { create } }) });
    const caught = await p.complete(opts).catch(error => error);
    expect(caught).toMatchObject({ outcome: "unknown", status: 500, providerRequestId: "req_failed" });
    expect(JSON.stringify(caught)).not.toMatch(/sk-ant|secret|body/);
  });
  test("known provider rejection stays distinct from uncertain transport failure", async () => {
    // Mutation: treat explicit rate-limit rejection as ambiguous or retry it invisibly.
    const create = vi.fn().mockRejectedValue(Object.assign(new Error("sensitive body"), { status: 429, request_id: "req_refused" }));
    const p = createAnthropicProvider({ createClient: () => ({ messages: { create } }) });
    await expect(p.complete(opts)).rejects.toMatchObject({ outcome: "refused", status: 429, providerRequestId: "req_refused" });
    expect(create).toHaveBeenCalledTimes(1);
  });
});

test("Google output usage cannot disappear behind a valid input count", async () => {
  // Mutation: missing candidatesTokenCount defaults to zero and underprices a generated answer.
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "generated output" }] } }], usageMetadata: { promptTokenCount: 20 } })));
  const p = createGoogleProvider({ fetch: fetcher });
  await expect(p.complete({ ...opts, model: p.defaultModel })).rejects.toMatchObject({ name: "ProviderUsageUnknownError", outcome: "unknown" });
});

test.each(["openai", "google"])("%s keeps HTTP IDs and rejects missing usage as unknown", async vendor => {
  // Mutation: fetch helper discards response headers or turns missing usage into free output.
  const raw = vendor === "openai" ? { id: "resp_synthetic", status: "completed", output: [], usage: { input_tokens: 20, input_tokens_details: { cached_tokens: 5 }, output_tokens: 3 } } : { responseId: "resp_synthetic", candidates: [{ finishReason: "STOP", content: { parts: [] } }], usageMetadata: { promptTokenCount: 20, cachedContentTokenCount: 5, candidatesTokenCount: 3 } };
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(raw), { headers: { "x-request-id": "req_synthetic" } }));
  const p = vendor === "openai" ? createOpenAIProvider({ fetch: fetcher }) : createGoogleProvider({ fetch: fetcher });
  expect(await p.complete({ ...opts, model: p.defaultModel })).toMatchObject({ providerRequestId: "req_synthetic", providerResponseId: "resp_synthetic", usage: { inputTokens: 15, cachedInputTokens: 5 } });
  fetcher.mockResolvedValue(new Response(JSON.stringify(vendor === "openai" ? { id: "resp_unknown", output: [] } : { responseId: "resp_unknown", candidates: [] }), { headers: { "x-request-id": "req_unknown" } }));
  await expect(p.complete({ ...opts, model: p.defaultModel })).rejects.toMatchObject({ name: "ProviderUsageUnknownError", providerRequestId: "req_unknown", outcome: "unknown" });
});
