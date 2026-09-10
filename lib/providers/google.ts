import type { CompleteOpts, Provider, SearchOpts } from "./types";
import { GOOGLE_DEFAULT_MODEL, GOOGLE_PRICED_MODELS, googleCostCents } from "./google-pricing";
import { array, postJson, record, tokens, type HttpDeps } from "./http";

export function createGoogleProvider(deps: HttpDeps = {}): Provider {
  const fetcher = deps.fetch ?? fetch;
  async function call(opts: CompleteOpts, search: boolean) {
    if (!GOOGLE_PRICED_MODELS.includes(opts.model)) throw new Error("Google model has no verified price.");
    const generationConfig: Record<string, unknown> = { maxOutputTokens: opts.maxTokens, candidateCount: 1, thinkingConfig: { thinkingBudget: 0 } };
    if (opts.jsonSchema) {
      generationConfig.responseMimeType = "application/json";
      generationConfig.responseJsonSchema = opts.jsonSchema;
    }
    const raw = await postJson(fetcher, "Google Gemini", `https://generativelanguage.googleapis.com/v1beta/models/${opts.model}:generateContent`, { "x-goog-api-key": opts.apiKey }, {
      systemInstruction: { parts: [{ text: opts.system }] }, contents: [{ role: "user", parts: [{ text: opts.prompt }] }], generationConfig,
      ...(search ? { tools: [{ google_search: {} }] } : {}),
    });
    const usage = record(raw.usageMetadata); const total = tokens(usage.promptTokenCount); const cached = tokens(usage.cachedContentTokenCount, true);
    if (cached > total) throw new Error("Google returned invalid cached usage.");
    const candidates = array(raw.candidates); const candidate = candidates[0] ?? {};
    const grounding = record(candidate.groundingMetadata);
    const queries = Array.isArray(grounding.webSearchQueries) ? grounding.webSearchQueries.filter(q => typeof q === "string" && q.trim()) : [];
    return {
      text: array(record(candidate.content).parts).filter(p => p.thought !== true && typeof p.text === "string").map(p => p.text).join("\n").trim(),
      usage: { inputTokens: total - cached, cachedInputTokens: cached, outputTokens: tokens(usage.candidatesTokenCount, true) + tokens(usage.thoughtsTokenCount, true), searches: queries.length, groundedRequests: search && (queries.length > 0 || array(grounding.groundingChunks).length > 0) ? 1 : 0 },
      stopReason: typeof candidate.finishReason === "string" ? candidate.finishReason : null,
    };
  }
  return {
    id: "google", defaultModel: GOOGLE_DEFAULT_MODEL, pricedModels: GOOGLE_PRICED_MODELS, costCents: googleCostCents, searchCapEnforcement: "none",
    complete: opts => call(opts, false),
    searchAndComplete: (opts: SearchOpts) => {
      if (opts.maxSearches !== undefined) return Promise.reject(new Error("Google search ceiling cannot be enforced by this adapter."));
      return call(opts, true);
    },
    async validateKey(key, model) {
      if (!key.trim() || /\s/.test(key)) return { ok: false, reason: "format" };
      try { await call({ apiKey: key, model, system: "Reply briefly", prompt: "Reply OK", maxTokens: 1 }, false); return { ok: true }; }
      catch { return { ok: false, reason: "rejected" }; }
    },
  };
}
