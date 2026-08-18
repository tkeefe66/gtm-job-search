// What a watchlist row should store about WHY a company was worth watching.
//
// Pure, and in lib/, for the usual reason: addToWatchlist is `"use server"`
// and reaches the database, so the derivation inside it is testable nowhere.
// The rule it encodes is small but load-bearing — a wrong fallback here is a
// blank card on the Watchlist page, not an error.

import { legacySignalFrom } from "@/lib/legacy-signal";
import type { Startup } from "@/lib/types";

export interface WatchlistSignalFields {
  /** The one-sentence signal, or null when the source row carries nothing. */
  signal: string | null;
  /** Per-signal detail keyed by the tenant's own `hiringSignal.extraFields`. */
  extras: Record<string, string>;
}

/**
 * `||`, not `??`, on the signal — unlike the Discover read path, which uses
 * `??` because it is reading rows the model wrote BEFORE the field existed
 * (absent, not empty). Here the value is being written fresh, and a model that
 * returned `signal: ""` should still get a line composed out of whatever
 * legacy fields it did fill rather than storing an empty string that renders
 * as nothing forever.
 *
 * Returns null rather than "" when there is genuinely nothing to say, so the
 * column distinguishes "no signal recorded" from "a signal that is blank" —
 * which is what lets Watchlist fall back to the legacy tags for old rows.
 */
export function watchlistSignalFields(startup: Startup): WatchlistSignalFields {
  const composed = startup.signal || legacySignalFrom(startup);
  return {
    signal: composed || null,
    extras: startup.extras ?? {},
  };
}

/**
 * The extras worth showing as tags: non-empty values only, in the order the
 * tenant's profile named them (object insertion order, which is the order the
 * model was asked for them).
 *
 * Kept out of the component so the "what renders" rule is testable — a
 * component's JSX is reachable from no test in this repo, which is the same
 * reason signInBody exists as a pure function.
 */
export function displayableExtras(
  extras: Record<string, string> | null | undefined
): [string, string][] {
  if (!extras) return [];
  return Object.entries(extras).filter(
    ([, v]) => typeof v === "string" && v.trim() !== ""
  );
}
