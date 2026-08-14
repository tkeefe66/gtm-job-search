// Deliberately approximate — surfaced in the UI as "~$X". Its job is making
// the Denver/Colorado overlap visible (those two terms cover nearly the same
// ground and account for a third of the grid), not precise billing.
const DOLLARS_PER_SEARCH = 0.01; // web_search server tool, ~$10 per 1,000
const TOKENS_PER_SEARCH_RESULT = 5_000; // results entering context, observed order of magnitude
const DOLLARS_PER_INPUT_TOKEN = 3 / 1_000_000; // claude-sonnet-4-6 input
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
  const searches = input.ceiling != null ? Math.min(grid, input.ceiling) : grid;

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
    input.ceiling !== null && e.searches < e.grid ? ` (capped at ${e.searches})` : "";
  return (
    `${factor} × ${plural(input.locations, "location")} = ` +
    `${plural(e.grid, "query", "queries")}${capped} · ` +
    `~$${e.dollars.toFixed(2)} per By Role run`
  );
}
