import Anthropic from "@anthropic-ai/sdk";
import { report } from "../usage.js";
import { ANTHROPIC_DEFAULT_MODEL, ANTHROPIC_PRICES, anthropicCostCents } from "./anthropic-pricing";
import type { Completion, CompleteOpts, KeyVerdict, Provider, SearchOpts, Usage } from "./types";

// The installed @anthropic-ai/sdk's ContentBlock union (TextBlock | ToolUseBlock)
// predates the web_search server tool and has no type for the `server_tool_use`
// blocks the API actually returns. There is no SDK type to import, so this is a
// hand-written structural guard rather than a cast to `any` — it only reads
// fields it has checked exist, and a block that doesn't match falls through.
interface WebSearchUseBlock {
  type: "server_tool_use";
  name: "web_search";
  input: { query?: unknown };
}

function isWebSearchUseBlock(block: unknown): block is WebSearchUseBlock {
  if (typeof block !== "object" || block === null) return false;
  const b = block as { type?: unknown; name?: unknown };
  return b.type === "server_tool_use" && b.name === "web_search";
}

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/**
 * Anthropic's `input_tokens` already EXCLUDES cached reads, so it maps straight
 * across. Cache CREATION is charged as (more expensive) fresh input, so it is
 * added to inputTokens rather than to cachedInputTokens — putting it in the
 * cached bucket would under-price it by 12x.
 */
function normaliseUsage(raw: RawUsage | undefined, searches: number): Usage {
  return {
    inputTokens: (raw?.input_tokens ?? 0) + (raw?.cache_creation_input_tokens ?? 0),
    cachedInputTokens: raw?.cache_read_input_tokens ?? 0,
    outputTokens: raw?.output_tokens ?? 0,
    searches,
  };
}

function textOf(content: unknown[]): string {
  return content
    .filter((b): b is { type: "text"; text: string } =>
      typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/** The injected seam is what lets the adapter be tested without a network. */
export interface AnthropicDeps {
  createClient?: (apiKey: string) => { messages: { create: (body: unknown) => Promise<unknown> } };
}

export function createAnthropicProvider(deps: AnthropicDeps = {}): Provider {
  const createClient =
    deps.createClient ??
    ((apiKey: string) =>
      new Anthropic({ apiKey }) as unknown as {
        messages: { create: (body: unknown) => Promise<unknown> };
      });

  return {
    id: "anthropic",
    defaultModel: ANTHROPIC_DEFAULT_MODEL,
    searchCapEnforcement: "in-request",

    costCents: anthropicCostCents,
    pricedModels: Object.keys(ANTHROPIC_PRICES),

    async complete(opts: CompleteOpts): Promise<Completion> {
      const body: Record<string, unknown> = {
        model: opts.model,
        max_tokens: opts.maxTokens,
        system: opts.system,
        messages: [{ role: "user", content: opts.prompt }],
      };
      if (opts.jsonSchema) {
        // Constrained decoding, expressed the way this SDK version allows: a
        // single tool the model is FORCED to call. The tool input is the JSON.
        body.tools = [{ name: "emit", description: "Return the result.", input_schema: opts.jsonSchema }];
        body.tool_choice = { type: "tool", name: "emit" };
      }

      const message = (await createClient(opts.apiKey).messages.create(body)) as {
        content: unknown[];
        usage?: RawUsage;
        stop_reason?: string | null;
      };
      report("gtm-job-search", opts.model, message.usage);

      const toolBlock = opts.jsonSchema
        ? (message.content.find(
            (b) => typeof b === "object" && b !== null && (b as { type?: unknown }).type === "tool_use"
          ) as { input?: unknown } | undefined)
        : undefined;

      return {
        text: toolBlock ? JSON.stringify(toolBlock.input) : textOf(message.content),
        usage: normaliseUsage(message.usage, 0),
        stopReason: message.stop_reason ?? null,
      };
    },

    async searchAndComplete(opts: SearchOpts): Promise<Completion> {
      // The same force-cast as before, and for the same reason: the installed
      // SDK (0.32.1) has no type for the web_search server tool at all, so
      // neither the `type` discriminator nor `max_uses` is expressible against
      // Anthropic.Tool. Built as a plain literal so its shape is still checked
      // internally, then cast once at the boundary.
      const webSearchTool = {
        type: "web_search_20250305",
        name: "web_search",
        ...(opts.maxSearches !== undefined ? { max_uses: opts.maxSearches } : {}),
      };

      const message = (await createClient(opts.apiKey).messages.create({
        model: opts.model,
        max_tokens: opts.maxTokens,
        system: opts.system,
        tools: [webSearchTool],
        messages: [{ role: "user", content: opts.prompt }],
      })) as { content: unknown[]; usage?: RawUsage; stop_reason?: string | null };

      report("gtm-job-search", opts.model, message.usage);

      const issued = message.content.filter(isWebSearchUseBlock);

      // Logging side-channel: which searches the model actually issued, as
      // opposed to which ones it was offered. Never let this break the call.
      try {
        if (issued.length > 0) {
          const queries = issued.map((b) =>
            typeof b.input?.query === "string" ? b.input.query : JSON.stringify(b.input)
          );
          console.log(`anthropic.searchAndComplete: issued ${issued.length} searches — ${queries.join(" | ")}`);
        }
      } catch (err) {
        console.error("anthropic.searchAndComplete: failed to log issued searches —", err);
      }

      return {
        text: textOf(message.content),
        usage: normaliseUsage(message.usage, issued.length),
        stopReason: message.stop_reason ?? null,
      };
    },

    async validateKey(key: string, model: string): Promise<KeyVerdict> {
      if (!key.startsWith("sk-ant-")) return { ok: false, reason: "format" };
      try {
        // The cheapest possible call — one token — against the model this key
        // will actually run on, NOT the default. A probe of the default proves
        // nothing about a key that cannot reach the model the tenant chose:
        // the row saves, and the failure surfaces later as "check your
        // ANTHROPIC_API_KEY" against a key that was never the problem.
        await createClient(key).messages.create({
          model,
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        });
        return { ok: true };
      } catch {
        // Deliberately drops the SDK's text: it embeds request URLs and
        // sometimes the key itself, and the caller renders this to a browser.
        return { ok: false, reason: "rejected" };
      }
    },
  };
}
