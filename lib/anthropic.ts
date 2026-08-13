import Anthropic from "@anthropic-ai/sdk";
import { report } from "./usage.js";

export const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || "",
});

export const MODEL = "claude-sonnet-4-6";

/**
 * Calls Claude with the web_search tool enabled and returns the concatenated
 * text output from all final text blocks. The SDK handles the tool loop when
 * web_search is a server tool, so the final message contains the model's text.
 */
export async function callWithWebSearch(opts: {
  system: string;
  prompt: string;
  maxTokens?: number;
}): Promise<string> {
  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: opts.maxTokens ?? 2000,
    system: opts.system,
    tools: [
      {
        type: "web_search_20250305",
        name: "web_search",
      } as unknown as Anthropic.Tool,
    ],
    messages: [{ role: "user", content: opts.prompt }],
  });

  // Token cost only -- web_search server-tool calls are billed per search and
  // are not part of the usage token counts, so they stay untracked.
  report("gtm-job-search", MODEL, message.usage);

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
