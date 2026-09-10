import {
  ANTHROPIC_CENTS_PER_SEARCH,
  ANTHROPIC_DEFAULT_MODEL,
  anthropicPrice,
} from "@/lib/providers/anthropic-pricing";
import { DEFAULT_ROLE_SEARCH_MAX_SEARCHES } from "@/lib/role-search-policy";

// Deliberately approximate — surfaced in the UI as "~$X". Its job is making the
// Denver/Colorado overlap visible, not precise billing. The RATES, though, come
// from the provider's own table rather than a third copy of them: this line is
// rendered to users, and a stale copy here shows a price the meter disagrees with.
const DOLLARS_PER_SEARCH = ANTHROPIC_CENTS_PER_SEARCH / 100;
const TOKENS_PER_SEARCH_RESULT = 5_000; // results entering context, observed order of magnitude
const DOLLARS_PER_INPUT_TOKEN = anthropicPrice(ANTHROPIC_DEFAULT_MODEL).input / 1_000_000;
const FIT_SCORING_DOLLARS = 0.19; // up to 25 scoreFit calls per run

export interface EstimateInput {
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
  const titleQueries = input.titles * input.locations;
  const stackQueries = input.stackTerms * input.locations;
  // A run is one family at a time; the larger grid is the worst case.
  const grid = Math.max(titleQueries, stackQueries);
  const searches = Math.min(
    grid,
    input.ceiling ?? DEFAULT_ROLE_SEARCH_MAX_SEARCHES
  );

  const dollars =
    searches === 0
      ? 0
      : searches * DOLLARS_PER_SEARCH +
        searches * TOKENS_PER_SEARCH_RESULT * DOLLARS_PER_INPUT_TOKEN +
        FIT_SCORING_DOLLARS;

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
    e.searches < e.grid
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
export function readingCostDollars(rows: number): number {
  if (rows <= 0) return 0;
  return (
    rows *
    (TOKENS_PER_POSTING_READ * DOLLARS_PER_INPUT_TOKEN +
      TOKENS_PER_POSTING_ANSWER * DOLLARS_PER_OUTPUT_TOKEN)
  );
}

/** The same figure as the UI shows it — approximate, and never a bare number. */
export function formatReadingCost(rows: number): string {
  return `~$${readingCostDollars(rows).toFixed(2)}`;
}
