import Anthropic from "@anthropic-ai/sdk";
import { report } from "../usage.js";
import { ANTHROPIC_DEFAULT_MODEL, ANTHROPIC_PRICES, anthropicCostCents } from "./anthropic-pricing";
import { ProviderRequestError, ProviderUsageUnknownError, safeProviderId, type ProviderMetadata } from "./errors";
import { record, tokens } from "./http";
import { effectiveSearchMode } from "./effective-search-mode";
import type { Completion, CompleteOpts, KeyVerdict, Provider, SearchOpts, Usage } from "./types";

/** SDK 0.32 lacks server-tool types but its APIPromise exposes withResponse. */
type MessageRequest = Promise<unknown> & {
  withResponse?: () => Promise<{ data: unknown; response: Response }>;
};
export interface AnthropicDeps {
  createClient?: (apiKey: string) => { messages: {
    create: (body: unknown, options?: { timeout: number; maxRetries: number }) => MessageRequest;
  } };
}

function normaliseUsage(value: unknown, search: boolean, metadata: ProviderMetadata): Usage {
  const raw = record(value);
  try {
    const inputTokens = tokens(raw.input_tokens);
    const outputTokens = tokens(raw.output_tokens);
    const cachedInputTokens = tokens(raw.cache_read_input_tokens, true);
    const created = tokens(raw.cache_creation_input_tokens, true);
    const breakdown = record(raw.cache_creation);
    const write5m = tokens(breakdown.ephemeral_5m_input_tokens, true);
    const write1h = tokens(breakdown.ephemeral_1h_input_tokens, true);
    // Positive cache totals alone do not say which TTL price was charged.
    if (created !== write5m + write1h) throw new ProviderUsageUnknownError(metadata);
    const searches = search ? tokens(record(raw.server_tool_use).web_search_requests) : 0;
    return { inputTokens, outputTokens, cachedInputTokens, searches,
      ...(created > 0 ? { cacheWrite5mTokens: write5m, cacheWrite1hTokens: write1h } : {}),
    };
  } catch { throw new ProviderUsageUnknownError(metadata); }
}

function textOf(content: unknown[]): string {
  return content.map(record).filter(b => b.type === "text" && typeof b.text === "string")
    .map(b => b.text).join("\n").trim();
}

export function createAnthropicProvider(deps: AnthropicDeps = {}): Provider {
  const createClient = deps.createClient ?? ((apiKey: string) =>
    new Anthropic({ apiKey, maxRetries: 0 }) as unknown as ReturnType<NonNullable<AnthropicDeps["createClient"]>>);

  async function request(opts: CompleteOpts, body: Record<string, unknown>, search: boolean): Promise<Completion> {
    let data: unknown;
    let providerRequestId: string | null = null;
    try {
      // Explicit per-call no-retry policy also covers injected clients.
      const pending = createClient(opts.apiKey).messages.create(body, { timeout: opts.timeoutMs ?? 120000, maxRetries: 0 });
      if (pending.withResponse) {
        const envelope = await pending.withResponse();
        data = envelope.data;
        providerRequestId = safeProviderId(envelope.response.headers.get("request-id") ?? envelope.response.headers.get("x-request-id"));
      } else {
        // Existing injected mocks can return a plain promise without HTTP metadata.
        data = await pending;
      }
    } catch (error) {
      const e = error as { status?: unknown; request_id?: unknown; message?: unknown };
      throw new ProviderRequestError("Anthropic", {
        status: typeof e?.status === "number" ? e.status : undefined,
        providerRequestId: e?.request_id,
        // Classify locally before dropping SDK text; never retain the body or key.
        billingBlocked: typeof e?.message === "string" && /credit balance|insufficient.*credit/i.test(e.message),
      });
    }
    const message = record(data);
    const metadata = { providerRequestId, providerResponseId: safeProviderId(message.id), stopReason: safeProviderId(message.stop_reason) };
    const usage = normaliseUsage(message.usage, search, metadata);
    report("gtm-job-search", opts.model, message.usage);
    const content = Array.isArray(message.content) ? message.content : [];
    const toolBlock = opts.jsonSchema ? content.map(record).find(b => b.type === "tool_use" && b.name === "emit") : undefined;
    // Log only aggregate counts; queries and provider bodies are not accounting metadata.
    if (search) console.log(`anthropic.searchAndComplete: provider reported ${usage.searches} billed searches`);
    return { text: toolBlock ? JSON.stringify(toolBlock.input ?? null) : textOf(content), usage, ...metadata, usageSource: "provider" };
  }

  return {
    id: "anthropic", defaultModel: ANTHROPIC_DEFAULT_MODEL, searchCapEnforcement: "in-request",
    costCents: anthropicCostCents, pricedModels: Object.keys(ANTHROPIC_PRICES),
    complete(opts: CompleteOpts): Promise<Completion> {
      const body: Record<string, unknown> = { model: opts.model, max_tokens: opts.maxTokens, system: opts.system, messages: [{ role: "user", content: opts.prompt }] };
      if (opts.jsonSchema) {
        body.tools = [{ name: "emit", description: "Return the result.", input_schema: opts.jsonSchema }];
        body.tool_choice = { type: "tool", name: "emit" };
      }
      return request(opts, body, false);
    },
    searchAndComplete(opts: SearchOpts): Promise<Completion> {
      if (opts.maxSearches !== undefined && (!Number.isSafeInteger(opts.maxSearches) || opts.maxSearches <= 0)) {
        return Promise.reject(new Error("Anthropic search ceiling must be a positive integer."));
      }
      // Explicit company call opt-in only. Filtering auto-provisions code execution.
      // https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
      const tool = { type: effectiveSearchMode("anthropic", opts.model, opts.searchMode) === "filtered" ? "web_search_20260209" : "web_search_20250305",
        name: "web_search", ...(opts.maxSearches !== undefined ? { max_uses: opts.maxSearches } : {}) };
      return request(opts, { model: opts.model, max_tokens: opts.maxTokens, system: opts.system,
        tools: [tool], messages: [{ role: "user", content: opts.prompt }] }, true);
    },
    async validateKey(key: string, model: string): Promise<KeyVerdict> {
      if (!key.startsWith("sk-ant-")) return { ok: false, reason: "format" };
      try {
        // Existing one-token key probe stays outside tenant operation accounting.
        await createClient(key).messages.create({ model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }, { timeout: 120000, maxRetries: 0 });
        return { ok: true };
      } catch { return { ok: false, reason: "rejected" }; }
    },
  };
}
