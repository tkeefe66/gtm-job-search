import {
  ANTHROPIC_CENTS_PER_SEARCH,
  ANTHROPIC_DEFAULT_MODEL,
  anthropicPrice,
  ANTHROPIC_PRICES,
  anthropicCostCents,
} from "@/lib/providers/anthropic-pricing";
import { OPENAI_DEFAULT_MODEL, openaiCostCents } from "@/lib/providers/openai-pricing";
import { GOOGLE_DEFAULT_MODEL, googleCostCents } from "@/lib/providers/google-pricing";
import type { ProviderId, Usage } from "@/lib/providers/types";
import { DEFAULT_ROLE_SEARCH_MAX_SEARCHES } from "@/lib/role-search-policy";

// Deliberately approximate — surfaced in the UI as "~$X". Its job is making the
// Denver/Colorado overlap visible, not precise billing. The RATES, though, come
// from the provider's own table rather than a third copy of them: this line is
// rendered to users, and a stale copy here shows a price the meter disagrees with.
const DOLLARS_PER_SEARCH = ANTHROPIC_CENTS_PER_SEARCH / 100;
const TOKENS_PER_SEARCH_RESULT = 5_000; // results entering context, observed order of magnitude
const DOLLARS_PER_INPUT_TOKEN = anthropicPrice(ANTHROPIC_DEFAULT_MODEL).input / 1_000_000;
const FIT_SCORING_DOLLARS = 0.19; // up to 25 scoreFit calls per run

export interface EstimateProvider {
  provider?: ProviderId;
  model?: string;
}

/** Browser-safe: imports price tables only, never an adapter or SDK. Costs are
 * approximate standard paid-tier dollars before external account allowances. */
export function estimateModelCostDollars(usage: Usage, config: EstimateProvider = {}): number {
  switch (config.provider ?? "anthropic") {
    case "openai": return openaiCostCents(usage, config.model ?? OPENAI_DEFAULT_MODEL) / 100;
    case "google": return googleCostCents(usage, config.model ?? GOOGLE_DEFAULT_MODEL) / 100;
    case "anthropic": {
      const model = config.model ?? ANTHROPIC_DEFAULT_MODEL;
      if (!Object.prototype.hasOwnProperty.call(ANTHROPIC_PRICES, model)) throw new Error("Anthropic model has no verified price.");
      return anthropicCostCents(usage, model) / 100;
    }
    default: throw new Error("Provider has no verified model price.");
  }
}

// Rough assumptions, not measured usage for the new providers: 2k input and
// 100 output tokens per role scored; no cache credit assumed. Price as aggregate
// usage, since the tenant meter reconciles a batch at its billing boundary.
export function rescoreCostDollars(rows: number, config: EstimateProvider = {}): number {
  return estimateModelCostDollars({ inputTokens: Math.max(0, rows) * 2000, cachedInputTokens: 0, outputTokens: Math.max(0, rows) * 100, searches: 0 }, config);
}

export interface EstimateInput extends EstimateProvider {
  titles: number;
  locations: number;
  stackTerms: number;
  ceiling: number | null;
}

export interface Estimate {
  titleQueries: number;
  stackQueries: number;
  /** The grid the dollar figure is for: the larger of the two, worst case. */
  grid: number;
  searches: number;
  dollars: number;
}

export function estimateRunCost(input: EstimateInput): Estimate {
  // Validate even an empty grid, rather than quietly pricing unknown models.
  estimateModelCostDollars({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, searches: 0 }, input);
  const titleQueries = input.titles * input.locations;
  const stackQueries = input.stackTerms * input.locations;
  // A run is one family at a time; the larger grid is the worst case.
  const grid = Math.max(titleQueries, stackQueries);
  const searches = Math.min(
    grid,
    input.ceiling ?? DEFAULT_ROLE_SEARCH_MAX_SEARCHES
  );

  let dollars =
    searches === 0
      ? 0
      : searches * DOLLARS_PER_SEARCH +
        searches * TOKENS_PER_SEARCH_RESULT * DOLLARS_PER_INPUT_TOKEN +
        FIT_SCORING_DOLLARS;

  if (searches > 0 && ((input.provider !== undefined && input.provider !== "anthropic") || (input.model !== undefined && input.model !== ANTHROPIC_DEFAULT_MODEL))) {
    // One By Role request contains the query grid. 5k context tokens/query and
    // 1k output tokens/run are planning assumptions, not a guaranteed ceiling.
    // Gemini 2.5 bills ONE grounded prompt even when it issues many queries;
    // OpenAI preview bills each tool call, with retrieval tokens free.
    dollars = estimateModelCostDollars({ inputTokens: searches * TOKENS_PER_SEARCH_RESULT, cachedInputTokens: 0, outputTokens: 1000, searches, groundedRequests: 1 }, input) + rescoreCostDollars(25, input);
  }

  return { titleQueries, stackQueries, grid, searches, dollars };
}

function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The one-line estimate the settings page shows under the titles and locations
 * lists, e.g. `13 titles × 3 locations = 39 queries · ~$1.17 per By Role run`.
 *
 * The line describes the grid the DOLLAR FIGURE IS FOR, whichever family that
 * is. A run is one family at a time and estimateRunCost prices the larger of
 * the two, so naming the title grid unconditionally made the line contradict
 * itself whenever the stack grid was bigger: 2 titles and 8 stack terms read
 * "2 titles × 3 locations = 6 queries" beside a price for 24 searches. Showing
 * whichever pair actually multiplies out to the priced grid keeps the
 * arithmetic on the line checkable by eye.
 *
 * When a ceiling cuts the grid down, the cap is stated — otherwise the line
 * would show 39 queries for a run the user has capped at 15 and the dollar
 * figure would look inexplicably low.
 */
export function formatEstimate(input: EstimateInput): string {
  const e = estimateRunCost(input);
  const stackDriven = e.stackQueries > e.titleQueries;
  const factor = stackDriven
    ? plural(input.stackTerms, "stack term")
    : plural(input.titles, "title");
  const capped =
    input.provider === "google"
      ? ` (assuming ${e.searches} searches; not an enforced cap)`
      : e.searches < e.grid
      ? input.ceiling === null
        ? ` (default cap ${DEFAULT_ROLE_SEARCH_MAX_SEARCHES})`
        : ` (capped at ${e.searches})`
      : "";
  return (
    `${factor} × ${plural(input.locations, "location")} = ` +
    `${plural(e.grid, "query", "queries")}${capped} · ` +
    `~$${e.dollars.toFixed(2)} per By Role run`
  );
}

// Reading ONE posting: the fetched page or board body in, a short structured
// answer out, no web search. Measured from usage_events on 2026-09-07 — 12
// enrich batches over ~50 rows billed 19¢, and an earlier 5-batch pass billed
// 5¢, which is roughly half a cent per posting actually read. The token figures
// below reproduce that order of magnitude from the provider's own rates rather
// than hardcoding the cent, so a model or price change moves this with it.
const TOKENS_PER_POSTING_READ = 1_400; // stripped page or board body, observed
const TOKENS_PER_POSTING_ANSWER = 200; // the structured requirements list
const DOLLARS_PER_OUTPUT_TOKEN = anthropicPrice(ANTHROPIC_DEFAULT_MODEL).output / 1_000_000;

/**
 * What reading `rows` postings costs, in dollars.
 *
 * The vocabulary this file was missing: every estimate here assumed a SEARCH,
 * so the enrich banner could report how many rows it read and never what that
 * cost — and since reads now happen inside ingest, that blind spot covers every
 * search and crawl too.
 */
export function readingCostDollars(rows: number, config: EstimateProvider = {}): number {
  estimateModelCostDollars({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, searches: 0 }, config);
  if (rows <= 0) return 0;
  if (((config.provider !== undefined && config.provider !== "anthropic") || (config.model !== undefined && config.model !== ANTHROPIC_DEFAULT_MODEL))) {
    return estimateModelCostDollars({ inputTokens: rows * TOKENS_PER_POSTING_READ, cachedInputTokens: 0, outputTokens: rows * TOKENS_PER_POSTING_ANSWER, searches: 0 }, config);
  }
  return (
    rows *
    (TOKENS_PER_POSTING_READ * DOLLARS_PER_INPUT_TOKEN +
      TOKENS_PER_POSTING_ANSWER * DOLLARS_PER_OUTPUT_TOKEN)
  );
}

/** The same figure as the UI shows it — approximate, and never a bare number. */
export function formatReadingCost(rows: number, config: EstimateProvider = {}): string {
  return `~$${readingCostDollars(rows, config).toFixed(2)}`;
}
