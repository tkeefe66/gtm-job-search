import { describe, expect, test, vi } from "vitest";
import { createAnthropicProvider } from "./anthropic";

function fakeClient(response: unknown) {
  const create = vi.fn().mockResolvedValue(response);
  return { create, factory: () => ({ messages: { create } }) };
}

const textOnly = {
  content: [{ type: "text", text: "hello" }],
  usage: { input_tokens: 100, output_tokens: 20 },
};

describe("the Anthropic adapter", () => {
  test("complete returns the concatenated text and normalised usage", async () => {
    const { factory } = fakeClient(textOnly);
    const p = createAnthropicProvider({ createClient: factory });

    const out = await p.complete({
      apiKey: "sk-ant-x", model: "claude-sonnet-4-6",
      system: "s", prompt: "p", maxTokens: 500,
    });

    expect(out.text).toBe("hello");
    expect(out.usage).toEqual({
      inputTokens: 100, cachedInputTokens: 0, outputTokens: 20, searches: 0,
    });
  });

  // The normalisation the spec calls out: Anthropic's input_tokens EXCLUDES
  // cached tokens, OpenAI's prompt_tokens includes them. Renaming the field
  // would over- or under-count by exactly the cached portion.
  test("cached tokens are reported separately, and input_tokens is left excluding them", async () => {
    const { factory } = fakeClient({
      ...textOnly,
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900 },
    });
    const p = createAnthropicProvider({ createClient: factory });

    const out = await p.complete({
      apiKey: "sk-ant-x", model: "claude-sonnet-4-6", system: "s", prompt: "p", maxTokens: 500,
    });

    expect(out.usage.inputTokens).toBe(100);
    expect(out.usage.cachedInputTokens).toBe(900);
  });

  test("searchAndComplete counts the searches the model ISSUED, not the ones it was allowed", async () => {
    const { factory, create } = fakeClient({
      content: [
        { type: "server_tool_use", name: "web_search", input: { query: "a" } },
        { type: "server_tool_use", name: "web_search", input: { query: "b" } },
        { type: "text", text: "done" },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const p = createAnthropicProvider({ createClient: factory });

    const out = await p.searchAndComplete({
      apiKey: "sk-ant-x", model: "claude-sonnet-4-6",
      system: "s", prompt: "p", maxTokens: 8000, maxSearches: 9,
    });

    expect(out.usage.searches).toBe(2);
    expect(create.mock.calls[0][0].tools[0].max_uses).toBe(9);
  });

  test("no maxSearches means the field is absent from the request, not zero", async () => {
    const { factory, create } = fakeClient(textOnly);
    const p = createAnthropicProvider({ createClient: factory });

    await p.searchAndComplete({
      apiKey: "sk-ant-x", model: "claude-sonnet-4-6", system: "s", prompt: "p", maxTokens: 8000,
    });

    expect(create.mock.calls[0][0].tools[0]).not.toHaveProperty("max_uses");
  });

  test("caps searches in-request, which is what makes a ceiling enforceable", () => {
    const p = createAnthropicProvider({ createClient: fakeClient(textOnly).factory });
    expect(p.searchCapEnforcement).toBe("in-request");
  });

  test("a key of the wrong shape is rejected on format, without a network call", async () => {
    const { factory, create } = fakeClient(textOnly);
    const p = createAnthropicProvider({ createClient: factory });

    expect(await p.validateKey("hunter2", "claude-sonnet-4-6")).toEqual({ ok: false, reason: "format" });
    expect(create).not.toHaveBeenCalled();
  });

  test("a key the API rejects comes back as rejected, with no SDK text attached", async () => {
    const create = vi.fn().mockRejectedValue(new Error("401 https://api.anthropic.com key=sk-ant-leak"));
    const p = createAnthropicProvider({ createClient: () => ({ messages: { create } }) });

    const verdict = await p.validateKey("sk-ant-plausible", "claude-sonnet-4-6");

    expect(verdict).toEqual({ ok: false, reason: "rejected" });
    expect(JSON.stringify(verdict)).not.toContain("sk-ant-leak");
  });

  test("a key the API accepts comes back ok", async () => {
    const p = createAnthropicProvider({ createClient: fakeClient(textOnly).factory });
    expect(await p.validateKey("sk-ant-plausible", "claude-sonnet-4-6")).toEqual({ ok: true });
  });

  // The whole point of the model argument: a good key against a model the
  // account cannot reach must fail HERE, at save time, and not later as
  // "check your ANTHROPIC_API_KEY" against a key that was never wrong.
  test("a valid key against a model the API rejects comes back as rejected", async () => {
    const create = vi.fn().mockRejectedValue(new Error("404 model: not_found_error"));
    const p = createAnthropicProvider({ createClient: () => ({ messages: { create } }) });

    expect(await p.validateKey("sk-ant-plausible", "claude-typo-9")).toEqual({
      ok: false,
      reason: "rejected",
    });
  });

  test("the probe carries the model it was passed, not the adapter's default", async () => {
    const { factory, create } = fakeClient(textOnly);
    const p = createAnthropicProvider({ createClient: factory });

    await p.validateKey("sk-ant-plausible", "claude-opus-4-1");

    expect(create.mock.calls[0][0].model).toBe("claude-opus-4-1");
    expect(create.mock.calls[0][0].model).not.toBe(p.defaultModel);
  });

  test("a json schema is sent as a forced tool, because constrained decoding is what makes weak models return parseable JSON", async () => {
    const { factory, create } = fakeClient({
      content: [{ type: "tool_use", name: "emit", input: { score: 4 } }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const p = createAnthropicProvider({ createClient: factory });

    const out = await p.complete({
      apiKey: "sk-ant-x", model: "claude-sonnet-4-6", system: "s", prompt: "p", maxTokens: 500,
      jsonSchema: { type: "object", properties: { score: { type: "number" } } },
    });

    expect(create.mock.calls[0][0].tool_choice).toEqual({ type: "tool", name: "emit" });
    expect(JSON.parse(out.text)).toEqual({ score: 4 });
  });
});
