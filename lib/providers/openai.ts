import type { CompleteOpts, Provider, SearchOpts } from "./types";
import { OPENAI_DEFAULT_MODEL, OPENAI_PRICED_MODELS, openaiCostCents } from "./openai-pricing";
import { array, postJson, record, tokens, type HttpDeps } from "./http";

export function createOpenAIProvider(deps: HttpDeps = {}): Provider {
  const fetcher = deps.fetch ?? fetch;
  async function call(opts: CompleteOpts, search: boolean, maxSearches?: number) {
    if (!OPENAI_PRICED_MODELS.includes(opts.model)) throw new Error("OpenAI model has no verified price.");
    const body: Record<string, unknown> = { model: opts.model, instructions: opts.system, input: opts.prompt, max_output_tokens: opts.maxTokens, store: false };
    if (search) {
      body.tools = [{ type: "web_search_preview" }];
      // Responses caps all built-in calls together. Search is the sole built-in
      // offered here, so this is an in-request search ceiling, not a prompt hint.
      // https://developers.openai.com/api/reference/cli/resources/responses/methods/create
      if (maxSearches !== undefined) body.max_tool_calls = maxSearches;
    }
    // Existing schemas intentionally permit extra properties. Non-strict forced
    // function calling preserves that contract; strict JSON schemas would close
    // objects and require absent facts. Never silently rewrite the schema.
    if (opts.jsonSchema) {
      body.tools = [{ type: "function", name: "emit", description: "Return the result.", parameters: opts.jsonSchema, strict: false }];
      body.tool_choice = { type: "function", name: "emit" };
      body.parallel_tool_calls = false;
    }
    const raw = await postJson(fetcher, "OpenAI", "https://api.openai.com/v1/responses", { Authorization: `Bearer ${opts.apiKey}` }, body);
    const usage = record(raw.usage); const cached = tokens(record(usage.input_tokens_details).cached_tokens, true); const total = tokens(usage.input_tokens);
    if (cached > total) throw new Error("OpenAI returned invalid cached usage.");
    const output = array(raw.output);
    const emitted = output.find(b => b.type === "function_call" && b.name === "emit");
    const content = output.flatMap(b => array(b.content));
    const searches = output.filter(b => b.type === "web_search_call");
    // Envelope completion does not certify a useful answer: refusals are
    // completed responses too, and a failed research tool cannot be salvaged
    // into trusted evidence that an employer has no openings. Keep usage so
    // metering still records the failed attempt.
    const stopReason = content.some(b => b.type === "refusal")
      ? "refusal"
      : searches.some(b => b.status !== "completed")
        ? "incomplete"
        : typeof raw.status === "string" ? raw.status : null;
    return {
      text: content.some(b => b.type === "refusal") || searches.some(b => b.status !== "completed")
        ? ""
        : opts.jsonSchema && typeof emitted?.arguments === "string" ? emitted.arguments : content.filter(b => b.type === "output_text" && typeof b.text === "string").map(b => b.text).join("\n").trim(),
      usage: { inputTokens: total - cached, cachedInputTokens: cached, outputTokens: tokens(usage.output_tokens), searches: searches.length },
      stopReason,
    };
  }
  return {
    id: "openai", defaultModel: OPENAI_DEFAULT_MODEL, pricedModels: OPENAI_PRICED_MODELS, costCents: openaiCostCents, searchCapEnforcement: "in-request",
    complete: opts => call(opts, false),
    searchAndComplete: (opts: SearchOpts) => {
      if (opts.maxSearches !== undefined && (!Number.isSafeInteger(opts.maxSearches) || opts.maxSearches <= 0)) return Promise.reject(new Error("OpenAI search ceiling must be a positive integer."));
      return call(opts, true, opts.maxSearches);
    },
    async validateKey(key, model) {
      if (!key.trim() || /\s/.test(key)) return { ok: false, reason: "format" };
      try { await call({ apiKey: key, model, system: "", prompt: "Reply OK", maxTokens: 16 }, false); return { ok: true }; }
      catch { return { ok: false, reason: "rejected" }; }
    },
  };
}
