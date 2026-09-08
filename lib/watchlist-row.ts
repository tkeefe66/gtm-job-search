/**
 * Which of the five states a Watchlist row is in.
 *
 * Pure and separate from the component because the ORDER of the checks is the
 * whole content of the decision and is invisible when wrong: a row that has no
 * careers URL has also been failing its checks, and a failing row is also
 * usually past its interval, so every row below matches more than one clause.
 * Reordering them silently relabels rows rather than breaking anything.
 *
 * The colours these map to live in components/Watchlist.tsx, NOT here:
 * tailwind.config.ts scans ./app/** and ./components/** only, so an
 * arbitrary-value class written in lib/ is never generated and renders
 * unstyled through a green build.
 */
export type RowState = "needs_url" | "failing" | "due" | "empty" | "ok";

export interface RowStateInput {
  trackingEnabled: boolean;
  lastCrawlStatus: string | null;
  consecutiveFailures: number;
  isDue: boolean;
}

/** A row the user has to act on — nothing the crawler will resolve by itself. */
export const NEEDS_YOU: readonly RowState[] = ["needs_url", "failing"];

export function needsYou(state: RowState): boolean {
  return NEEDS_YOU.includes(state);
}

export function rowStateFor(input: RowStateInput): RowState {
  // An untracked row has no schedule and no failures worth reporting as a
  // state — the reason it stopped is rendered as prose instead.
  if (!input.trackingEnabled) return "ok";

  // Before "failing": a needs_url row IS a failing row, and the missing URL is
  // the actionable half. Reversed, the one state with a fix on the row loses
  // to the one without.
  if (input.lastCrawlStatus === "needs_url") return "needs_url";

  // Matches the existing threshold in the row copy: three in a row is what the
  // page has always called failing.
  if (input.consecutiveFailures >= 3) return "failing";

  // Before "empty": a row can be both past its interval and empty on its last
  // check, and "due" is the one that describes what happens next.
  if (input.isDue) return "due";

  if (input.lastCrawlStatus === "empty") return "empty";

  return "ok";
}
