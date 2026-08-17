import { billingScope, recordUsage } from "./billing-context";
import { providerFor } from "./providers/registry";
import { mustRefuseSearch } from "./providers/types";
import { ANTHROPIC_DEFAULT_MODEL } from "./providers/anthropic-pricing";
import type { Completion, Provider } from "./providers/types";

/**
 * The provider-neutral entry point for every model call in the app.
 *
 * Named for what it does rather than for a vendor, because after the provider
 * registry landed this file contains no Anthropic specifics at all — those are
 * in lib/providers/anthropic.ts.
 *
 * Routing comes from the ambient BillingScope, not from a parameter: scoreFit
 * is reached three levels down inside ingestRoles' Promise.all, and threading a
 * provider through every signature between here and there is precisely what the
 * AsyncLocalStorage exists to avoid.
 */

/**
 * A search was requested under a ceiling the resolved provider cannot enforce
 * inside the request.
 *
 * Thrown rather than silently uncapped: search billing is invisible to token
 * usage, so an unenforceable cap is not a smaller cap, it is no cap. Caught in
 * lib/metered.ts and returned as `capped`, so the user reads a sentence.
 */
export class SearchUnavailableError extends Error {
  constructor(providerId: string) {
    super(
      `Search is not available on ${providerId} for a metered account, because that ` +
        `provider cannot limit how many searches one request runs. Add your own API key ` +
        `to use search, or choose a provider that supports a per-request limit.`
    );
    this.name = "SearchUnavailableError";
  }
}

/** Provider, key and model for this call: the scope's, or the platform's. */
function routing(): { provider: Provider; apiKey: string; model: string; maxSearches: number | null } {
  const s = billingScope();
  // Null is a real state, not an error: db/apply-schema, tests and one-off
  // scripts call these helpers with no budget in play.
  if (s === null) {
    return {
      provider: providerFor("anthropic"),
      apiKey: process.env.ANTHROPIC_API_KEY || "",
      model: ANTHROPIC_DEFAULT_MODEL,
      maxSearches: null,
    };
  }
  return {
    provider: providerFor(s.provider),
    apiKey: s.apiKey,
    model: s.model,
    maxSearches: s.maxSearches,
  };
}

function collect(c: Completion): string {
  recordUsage(c.usage);
  return c.text;
}

/**
 * A call with the provider's native search tool.
 *
 * `maxSearches` sets the per-request ceiling — the only hard limit on how many
 * individually billed searches a call can run. An explicit argument wins (the
 * role-search path computes one from the user's ceiling); otherwise the
 * budget's cap applies.
 */
export async function callWithWebSearch(opts: {
  system: string;
  prompt: string;
  maxTokens?: number;
  maxSearches?: number;
}): Promise<string> {
  const { provider, apiKey, model, maxSearches } = routing();
  if (mustRefuseSearch(provider.searchCapEnforcement, maxSearches)) {
    throw new SearchUnavailableError(provider.id);
  }
  const cap = opts.maxSearches ?? (maxSearches === null ? undefined : maxSearches);
  return collect(
    await provider.searchAndComplete({
      apiKey,
      model,
      system: opts.system,
      prompt: opts.prompt,
      maxTokens: opts.maxTokens ?? 2000,
      ...(cap !== undefined ? { maxSearches: cap } : {}),
    })
  );
}

/**
 * A plain completion with no tools. Used to extract roles from page text that
 * has already been fetched — the fetch tier's cost win comes from not paying
 * for searches when the page content is already in hand.
 */
export async function callStructured(opts: {
  system: string;
  prompt: string;
  maxTokens?: number;
}): Promise<string> {
  return complete({ ...opts, maxTokens: opts.maxTokens ?? 4000 });
}

/** A completion, optionally with a JSON schema the model is constrained to. */
export async function complete(opts: {
  system: string;
  prompt: string;
  maxTokens?: number;
  jsonSchema?: Record<string, unknown>;
}): Promise<string> {
  const { provider, apiKey, model } = routing();
  return collect(
    await provider.complete({
      apiKey,
      model,
      system: opts.system,
      prompt: opts.prompt,
      maxTokens: opts.maxTokens ?? 4000,
      ...(opts.jsonSchema ? { jsonSchema: opts.jsonSchema } : {}),
    })
  );
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
