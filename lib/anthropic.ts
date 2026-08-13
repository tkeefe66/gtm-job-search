import Anthropic from "@anthropic-ai/sdk";
import { report } from "./usage.js";

export const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || "",
});

export const MODEL = "claude-sonnet-4-6";

// The installed @anthropic-ai/sdk's ContentBlock union (TextBlock | ToolUseBlock,
// see node_modules/@anthropic-ai/sdk/resources/messages.d.ts) predates the
// web_search server tool and has no type for the `server_tool_use` blocks the
// API actually returns when the model issues a search. There is no SDK type to
// import, so this is a hand-written structural guard rather than a cast to
// `any` — it only reads fields it has checked exist, and a block that doesn't
// match falls through untouched.
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

/**
 * Calls Claude with the web_search tool enabled and returns the concatenated
 * text output from all final text blocks. The SDK handles the tool loop when
 * web_search is a server tool, so the final message contains the model's text.
 *
 * `maxSearches` sets the tool block's `max_uses` — the only hard ceiling on
 * how many (individually billed) searches the call can run. It is optional and
 * omitted by default: the field is absent from the request unless a caller
 * asks for it, so discover.ts, roles.ts, and crawler.ts keep sending exactly
 * the request they sent before. Only role-search.ts, whose prompt hands the
 * model a long query list and invites it to run them all, sets it today.
 */
export async function callWithWebSearch(opts: {
  system: string;
  prompt: string;
  maxTokens?: number;
  maxSearches?: number;
}): Promise<string> {
  // Same force-cast as before, and for the same reason: the installed SDK
  // (0.32.1) has no type for the web_search server tool at all — no
  // WebSearchTool20250305 in resources/messages.d.ts — so neither the `type`
  // discriminator nor `max_uses` is expressible against Anthropic.Tool. The
  // object is built as a plain literal (not `any`) so its shape is still
  // checked internally, then cast once at the boundary.
  const webSearchTool = {
    type: "web_search_20250305",
    name: "web_search",
    ...(opts.maxSearches !== undefined ? { max_uses: opts.maxSearches } : {}),
  } as unknown as Anthropic.Tool;

  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: opts.maxTokens ?? 2000,
    system: opts.system,
    tools: [webSearchTool],
    messages: [{ role: "user", content: opts.prompt }],
  });

  // Token cost only -- web_search server-tool calls are billed per search and
  // are not part of the usage token counts, so they stay untracked.
  report("gtm-job-search", MODEL, message.usage);

  // Logging side-channel: which searches the model actually issued (as
  // opposed to which ones we offered it). Never let this break the call.
  try {
    // Cast to unknown[] rather than relying on `.filter`'s type-guard overload
    // inferring correctly: the SDK's element type (TextBlock | ToolUseBlock)
    // doesn't satisfy the `S extends T` constraint against WebSearchUseBlock,
    // so without this the guard silently degrades to the untyped overload.
    const issued = (message.content as unknown[])
      .filter(isWebSearchUseBlock)
      .map((block) =>
        typeof block.input?.query === "string" ? block.input.query : JSON.stringify(block.input)
      );
    if (issued.length > 0) {
      console.log(`callWithWebSearch: issued ${issued.length} searches — ${issued.join(" | ")}`);
    }
  } catch (err) {
    console.error("callWithWebSearch: failed to log issued searches —", err);
  }

  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/**
 * A plain completion with no tools. Used to extract roles from page text that
 * has already been fetched — the fetch tier's cost win comes from not paying
 * for web searches when the page content is already in hand.
 */
export async function callStructured(opts: {
  system: string;
  prompt: string;
  maxTokens?: number;
}): Promise<string> {
  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: opts.maxTokens ?? 4000,
    system: opts.system,
    messages: [{ role: "user", content: opts.prompt }],
  });

  report("gtm-job-search", MODEL, message.usage);

  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/**
 * Strips markdown code fences and extracts the first JSON value (array or
 * object) from a model response, then parses it.
 */
export function parseJson<T>(raw: string): T {
  let text = raw.trim();

  // Remove markdown fences if present.
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }

  // Find the first array or object boundary.
  const firstBracket = text.indexOf("[");
  const firstBrace = text.indexOf("{");
  let start = -1;
  if (firstBracket === -1) start = firstBrace;
  else if (firstBrace === -1) start = firstBracket;
  else start = Math.min(firstBracket, firstBrace);

  if (start > 0) {
    text = text.slice(start);
  }

  // Trim trailing non-JSON content.
  const lastBracket = text.lastIndexOf("]");
  const lastBrace = text.lastIndexOf("}");
  const end = Math.max(lastBracket, lastBrace);
  if (end !== -1) {
    text = text.slice(0, end + 1);
  }

  return JSON.parse(text) as T;
}
