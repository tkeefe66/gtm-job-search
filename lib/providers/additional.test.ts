import { expect, test, vi } from "vitest";
import { createOpenAIProvider } from "./openai";
import { createGoogleProvider } from "./google";

const opts = { apiKey: "test-key", model: "gpt-4.1", system: "s", prompt: "p", maxTokens: 500 };
const openResponse = { status: "completed", output: [{ type: "web_search_call", status: "completed" }, { type: "message", content: [{ type: "output_text", text: "answer" }] }], usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 200 }, output_tokens: 30 } };
const googleResponse = { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "answer" }] }, groundingMetadata: { webSearchQueries: ["a", "b"] } }], usageMetadata: { promptTokenCount: 1000, cachedContentTokenCount: 200, candidatesTokenCount: 30, thoughtsTokenCount: 40 } };
function fake(response: unknown) { return vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(response))); }

test("OpenAI uses real search, subtracts cache, and prices preview calls", async () => {
  const fetch = fake(openResponse); const p = createOpenAIProvider({ fetch });
  const result = await p.searchAndComplete(opts);
  expect(result).toEqual({ text: "answer", stopReason: "completed", usage: { inputTokens: 800, cachedInputTokens: 200, outputTokens: 30, searches: 1 } });
  expect(JSON.parse(fetch.mock.calls[0][1]!.body as string).tools).toEqual([{ type: "web_search_preview" }]);
  expect(p.costCents({ inputTokens: 1000000, cachedInputTokens: 1000000, outputTokens: 1000000, searches: 2 }, opts.model)).toBe(1055);
});
test("Google counts thoughts and prices one grounded request rather than each query", async () => {
  const fetch = fake(googleResponse); const p = createGoogleProvider({ fetch });
  const result = await p.searchAndComplete({ ...opts, model: p.defaultModel });
  expect(result.usage).toEqual({ inputTokens: 800, cachedInputTokens: 200, outputTokens: 70, searches: 2, groundedRequests: 1 });
  expect(JSON.parse(fetch.mock.calls[0][1]!.body as string).tools).toEqual([{ google_search: {} }]);
  expect(p.costCents({ inputTokens: 1000000, cachedInputTokens: 1000000, outputTokens: 1000000, searches: 5, groundedRequests: 1 }, p.defaultModel)).toBe(287);
});
for (const [name, create, response] of [["OpenAI", createOpenAIProvider, openResponse], ["Google", createGoogleProvider, googleResponse]] as const) {
  test(`${name} refuses unpriceable models and unenforceable caps before HTTP`, async () => {
    const fetch = fake(response); const p = create({ fetch });
    await expect(p.complete({ ...opts, model: "unknown" })).rejects.toThrow(/model/i);
    if (name === "Google") await expect(p.searchAndComplete({ ...opts, model: p.defaultModel, maxSearches: 2 })).rejects.toThrow(/ceiling/i);
    expect(fetch).not.toHaveBeenCalled();
  });
  test(`${name} sanitizes rate-limit failures and missing usage fails closed`, async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("SECRET", { status: 429 }));
    const p = create({ fetch });
    await expect(p.complete({ ...opts, model: p.defaultModel })).rejects.toThrow(/rate limit/i);
    fetch.mockResolvedValue(new Response(JSON.stringify({ candidates: [], output: [] })));
    await expect(p.complete({ ...opts, model: p.defaultModel })).rejects.toThrow(/usage/i);
  });
  test(`${name} validates the selected model, never passes raw provider failures`, async () => {
    const fetch = fake(response); const p = create({ fetch });
    expect(await p.validateKey("test-key", "unknown")).toEqual({ ok: false, reason: "rejected" });
    expect(fetch).not.toHaveBeenCalled();
    expect(await p.validateKey("test-key", p.defaultModel)).toEqual({ ok: true });
    expect(fetch.mock.calls[0][0]).toContain(name === "OpenAI" ? "api.openai.com" : p.defaultModel);
  });
}

test("OpenAI caps built-in search calls inside the request", async () => {
  const fetch = fake(openResponse); const p = createOpenAIProvider({ fetch });
  expect(p.searchCapEnforcement).toBe("in-request");
  await p.searchAndComplete({ ...opts, maxSearches: 3 });
  expect(JSON.parse(fetch.mock.calls[0][1]!.body as string).max_tool_calls).toBe(3);
  for (const maxSearches of [0, -1, 1.5, NaN, Infinity]) {
    await expect(p.searchAndComplete({ ...opts, maxSearches })).rejects.toThrow(/ceiling/i);
  }
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("OpenAI structured output preserves open schema and returns function arguments", async () => {
  const fetch = fake({ ...openResponse, output: [{ type: "function_call", name: "emit", arguments: '{"score":4}' }] });
  const p = createOpenAIProvider({ fetch }); const jsonSchema = { type: "object", properties: { score: { type: "integer" } } };
  expect((await p.complete({ ...opts, jsonSchema })).text).toBe('{"score":4}');
  const body = JSON.parse(fetch.mock.calls[0][1]!.body as string);
  expect(body.tools[0].parameters).toEqual(jsonSchema);
  expect(body.tool_choice).toEqual({ type: "function", name: "emit" });
  expect(body.tools[0].strict).toBe(false);
});
test("Google structured output preserves schema and keeps truncation distinct", async () => {
  const fetch = fake({ ...googleResponse, candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ thought: true, text: "hidden" }, { text: "partial" }] } }] });
  const p = createGoogleProvider({ fetch }); const jsonSchema = { type: "object", properties: { score: { type: "integer" } } };
  const result = await p.complete({ ...opts, model: p.defaultModel, jsonSchema });
  expect(result.text).toBe("partial"); expect(result.stopReason).toBe("MAX_TOKENS"); expect(result.usage.outputTokens).toBe(70);
  expect(JSON.parse(fetch.mock.calls[0][1]!.body as string).generationConfig.responseJsonSchema).toEqual(jsonSchema);
});
test("OpenAI incomplete responses keep usage and cannot masquerade as completed", async () => {
  const p = createOpenAIProvider({ fetch: fake({ ...openResponse, status: "incomplete" }) });
  const result = await p.complete(opts);
  expect(result.stopReason).toBe("incomplete"); expect(result.usage.outputTokens).toBe(30);
});

test("OpenAI completed envelope cannot make a refusal salvageable", async () => {
  const p = createOpenAIProvider({ fetch: fake({ ...openResponse, output: [{ type: "message", content: [{ type: "refusal", refusal: "Cannot answer" }] }] }) });
  const result = await p.complete(opts);
  expect(result.stopReason).toBe("refusal");
  expect(result.text).toBe("");
  expect(result.usage.outputTokens).toBe(30);
});
test.each(["failed", "incomplete", "in_progress", "searching", undefined])("OpenAI search status %s cannot become a confirmed-complete answer", async status => {
  const p = createOpenAIProvider({ fetch: fake({ ...openResponse, output: [{ type: "web_search_call", status }, ...openResponse.output.slice(1)] }) });
  const result = await p.searchAndComplete(opts);
  expect(result.stopReason).not.toBe("completed");
  expect(result.text).toBe("");
  expect(result.usage.searches).toBe(1);
  expect(result.usage.outputTokens).toBe(30);
});
