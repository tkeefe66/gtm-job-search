/**
 * What the app needs from a model provider, and nothing more.
 *
 * Three fields here exist because a review found each of them missing, and each
 * one is a place where a second provider would otherwise be silently wrong:
 *
 * - `searchCapEnforcement`, because a ceiling is only enforceable INSIDE the
 *   request. web_search calls are billed per search and are invisible to token
 *   usage, so a pre-call check catches the next click, not this one.
 * - `costCents`, because Sonnet's $3/$15 was hardcoded in two places, one of
 *   them rendered to users. A GPT tenant would read Claude-priced fiction.
 * - `Usage`, normalised, because Anthropic's `input_tokens` EXCLUDES cached
 *   tokens and OpenAI's `prompt_tokens` includes them. Renaming the field would
 *   over- or under-count by exactly the cached portion.
 */

export type ProviderId = "anthropic" | "openai" | "google";

/** Whether a max-searches ceiling can be enforced inside the request itself. */
export type SearchCapEnforcement = "in-request" | "none";

export interface Usage {
  /** EXCLUDING cached input. Normalised across providers. */
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** Counted by the adapter from what the model ISSUED, never from the cap. */
  searches: number;
}

export interface Completion {
  text: string;
  usage: Usage;
}

export interface CallOpts {
  apiKey: string;
  model: string;
  system: string;
  prompt: string;
  maxTokens: number;
}

export interface CompleteOpts extends CallOpts {
  /** Constrained decoding. On the interface from the start: freezing the
   *  signature without it means rewriting every adapter later. */
  jsonSchema?: Record<string, unknown>;
}

export interface SearchOpts extends CallOpts {
  maxSearches?: number;
}

/**
 * Why a key was refused. A REASON, not a message: the message is UI copy and
 * lives with the action, because SDK error text embeds request URLs and
 * sometimes the key itself and must never reach a browser.
 */
export type KeyVerdict = { ok: true } | { ok: false; reason: "format" | "rejected" };

export interface Provider {
  id: ProviderId;
  defaultModel: string;
  searchCapEnforcement: SearchCapEnforcement;
  complete(opts: CompleteOpts): Promise<Completion>;
  searchAndComplete(opts: SearchOpts): Promise<Completion>;
  /** Cost in cents, per provider AND resolved model. Never a shared constant. */
  costCents(usage: Usage, model: string): number;
  /**
   * Probe the key against the model it will ACTUALLY run on.
   *
   * `model` is not optional and is not the adapter's default: a tenant who
   * types a typo'd or inaccessible model passes a default-model probe, has the
   * key sealed and stored, and only learns at first use — where the message
   * blames the key. They rotate a key that was fine. The argument is on the
   * interface now precisely so the second adapter does not reopen it.
   */
  validateKey(key: string, model: string): Promise<KeyVerdict>;
}

/**
 * A metered call on a provider that cannot cap searches inside the request is
 * REFUSED, not run uncapped.
 *
 * `maxSearches` is null only for BYO, who spend their own money and are recorded
 * rather than rationed. Any number means a ceiling is in force, and a ceiling
 * that cannot be enforced in-request is not a ceiling — search billing is
 * invisible to token usage, so nothing downstream would notice it being blown.
 */
export function mustRefuseSearch(
  enforcement: SearchCapEnforcement,
  maxSearches: number | null
): boolean {
  return enforcement === "none" && maxSearches !== null;
}
