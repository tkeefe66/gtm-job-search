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

  return { titleQueries, stackQueries, searches, dollars };
}

function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The one-line estimate the settings page shows under the titles and locations
 * lists, e.g. `13 titles × 3 locations = 39 queries · ~$1.17 per By Role run`.
 *
 * The query figure is the TITLE grid, because that is the grid the two numbers
 * beside it multiply out to; the dollar figure comes from estimateRunCost,
 * which prices the larger of the two grids. When a ceiling cuts the grid down,
 * the cap is stated — otherwise the line would show 39 queries for a run the
 * user has capped at 15 and the dollar figure would look inexplicably low.
 */
export function formatEstimate(input: EstimateInput): string {
  const e = estimateRunCost(input);
  const capped =
    input.ceiling !== null && e.searches < e.titleQueries
      ? ` (capped at ${e.searches})`
      : "";
  return (
    `${plural(input.titles, "title")} × ${plural(input.locations, "location")} = ` +
    `${plural(e.titleQueries, "query", "queries")}${capped} · ` +
    `~$${e.dollars.toFixed(2)} per By Role run`
  );
}
