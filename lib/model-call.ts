import { assertModelComplete } from "./model-response";
import { parseModelJson } from "./json-response";
import { DEFAULT_ROLE_SEARCH_MAX_SEARCHES, ROLE_SEARCH_MAX_TOKENS } from "./role-search-policy";
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
      `This search requires a per-request limit that ${providerId} cannot enforce. ` +
        `Use a provider that supports search limits for this operation.`
    );
    this.name = "SearchUnavailableError";
  }
}

export class SpendLimitReachedError extends Error {
  constructor(message = "Your app spending limit has been reached. Raise it in Settings before starting more AI work.") {
    super(message);
    this.name = "SpendLimitReachedError";
  }
}

/** Provider, key and model for this call: the scope's, or the platform's. */
async function routing(): Promise<{ provider: Provider; apiKey: string; model: string; maxSearches: number | null }> {
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
  const provider = providerFor(s.provider);
  const allowance = s.refreshAllowance ? await s.refreshAllowance() : s;
  let maxSearches = allowance.maxSearches;
  if (allowance.availableCents !== undefined) {
    const spent = provider.costCents({ ...s, groundedRequests: s.groundedRequests ?? 0 }, s.model);
    const remaining = allowance.availableCents - spent;
    if (remaining <= 0) throw new SpendLimitReachedError(allowance.limitMessage);
    const searchPrice = provider.costCents({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, searches: 1, groundedRequests: 1 }, s.model);
    if (maxSearches !== null && searchPrice > 0) maxSearches = Math.min(maxSearches, Math.floor(remaining / searchPrice));
  }
  return {
    provider,
    apiKey: s.apiKey,
    model: s.model,
    maxSearches,
  };
}

async function collect(c: Completion): Promise<string> {
  recordUsage(c.usage);
  await billingScope()?.flushUsage?.();
  return c.text;
}

/**
 * A response plus WHY THE MODEL STOPPED — the two facts a caller needs to tell
 * a truncated answer apart from one that ignored its output-format
 * instruction. See lib/prose-salvage.ts for why those must not be handled the
 * same way.
 */
export interface DetailedResponse {
  text: string;
  stopReason: string | null;
}

async function collectDetailed(c: Completion): Promise<DetailedResponse> {
  recordUsage(c.usage);
  await billingScope()?.flushUsage?.();
  return { text: c.text, stopReason: c.stopReason };
}

/**
 * A call with the provider's native search tool.
 *
 * `maxSearches` sets the per-request ceiling — the only hard limit on how many
 * individually billed searches a call can run. A caller can tighten the
 * ambient budget's cap, never raise it. With no ambient cap, the caller's
 * explicit ceiling still applies (including on a BYO account).
 */
export async function callWithWebSearch(opts: {
  system: string;
  prompt: string;
  maxTokens?: number;
  maxSearches?: number;
}): Promise<string> {
  const result = await callWithWebSearchDetailed(opts);
  assertModelComplete(result.stopReason);
  return result.text;
}

/**
 * The same call, keeping the stop reason.
 *
 * Split rather than widening callWithWebSearch's return type: five call sites
 * only ever wanted the text, and changing all of them to reach through a
 * wrapper object would be churn that buys nothing. A caller that needs to
 * recover from an unparseable response takes this one.
 */
export async function callWithWebSearchDetailed(opts: {
  system: string;
  prompt: string;
  maxTokens?: number;
  maxSearches?: number;
}): Promise<DetailedResponse> {
  const { provider, apiKey, model, maxSearches } = await routing();
  const requested = opts.maxSearches ?? DEFAULT_ROLE_SEARCH_MAX_SEARCHES;
  const cap = maxSearches === null ? requested : Math.min(requested, maxSearches);
  if (cap !== undefined && cap <= 0) throw new SpendLimitReachedError(billingScope()?.limitMessage);
  if (mustRefuseSearch(provider.searchCapEnforcement, cap ?? null)) {
    throw new SearchUnavailableError(provider.id);
  }
  return collectDetailed(
    await provider.searchAndComplete({
      apiKey,
      model,
      system: opts.system,
      prompt: opts.prompt,
      maxTokens: opts.maxTokens ?? ROLE_SEARCH_MAX_TOKENS,
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
  const { provider, apiKey, model } = await routing();
  const result = await provider.complete({
      apiKey,
      model,
      system: opts.system,
      prompt: opts.prompt,
      maxTokens: opts.maxTokens ?? 4000,
      ...(opts.jsonSchema ? { jsonSchema: opts.jsonSchema } : {}),
    });
  const text = await collect(result);
  assertModelComplete(result.stopReason, !!opts.jsonSchema);
  return text;
}

/**
 * The same call as `complete`, keeping the stop reason.
 *
 * `complete` validates it before returning text. The résumé chat
 * caller also needs the status to explain why it rejected a response:
 * the forced-tool path (lib/providers/anthropic.ts:96-104) returns
 * `JSON.stringify(toolBlock.input)` regardless of how the call stopped, so a
 * cut-off response still parses into a valid-LOOKING object with fields
 * silently missing. Split from `complete` rather than widening its return
 * type, the same way `callWithWebSearchDetailed` sits beside
 * `callWithWebSearch`: every existing caller only ever wanted the text.
 */
export async function completeDetailed(opts: {
  system: string;
  prompt: string;
  maxTokens?: number;
  jsonSchema?: Record<string, unknown>;
}): Promise<DetailedResponse> {
  const { provider, apiKey, model } = await routing();
  return collectDetailed(
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
 * Extracts one complete JSON value from a framed model answer, ignoring
 * bracketed citations and rejecting incomplete or ambiguous containers.
 */
export function parseJson<T>(raw: string): T {
  return parseModelJson<T>(raw);
}
