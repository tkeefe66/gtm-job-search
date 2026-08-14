// Driving rescoreAll from the client: what a rescore costs, when to ask for
// another batch, how many batches to allow, and how to describe the result
// without overstating it.
//
// All four are decisions that are wrong in expensive or dishonest ways, and
// none of them can be tested through the component (this repo does not unit
// test React) or through the action (it calls Claude). They live here.

import { DEFAULT_RESCORE_LIMIT } from "@/lib/rescore-scope";

/**
 * Measured cost of one scoreFit call. The single home for this constant —
 * components/RescorePrompt.tsx derives its dollar figure from `count` through
 * rescoreCostDollars rather than taking one as a prop, so the number in the
 * prompt and the number in any other caller cannot drift.
 */
export const DOLLARS_PER_RESCORE = 0.0075;

/** What rescoring `count` rows costs, rounded to whole cents for display. */
export function rescoreCostDollars(count: number): number {
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.round(count * DOLLARS_PER_RESCORE * 100) / 100;
}

/**
 * Whether to ask rescoreAll for another batch.
 *
 * `remaining > 0` ALONE is not a drain condition, and writing it that way is
 * the bug this function exists to prevent: a row that fails to score keeps its
 * old `updated_at` and therefore stays counted in `remaining` forever, so a
 * loop on that condition spins — spending a Claude call per row per pass —
 * until something times out. Requiring `rescored > 0` means every additional
 * batch is paid for by real forward progress.
 */
export function shouldContinueRescore(result: {
  rescored: number;
  remaining: number;
}): boolean {
  return result.remaining > 0 && result.rescored > 0;
}

/**
 * A hard ceiling on batches, independent of the progress condition above.
 *
 * Belt and braces: the loop is already required to make progress, but this is
 * a client loop calling a paid server action, and a bug in the progress
 * arithmetic must not be able to bill indefinitely. Sized from the row count
 * the page already knows, plus one batch of slack for rows added while the
 * pass runs.
 */
export function maxRescoreBatches(
  count: number,
  batchSize: number = DEFAULT_RESCORE_LIMIT
): number {
  if (!Number.isFinite(count) || count <= 0) return 1;
  return Math.ceil(count / batchSize) + 1;
}

export interface RescoreTotals {
  rescored: number;
  failed: number;
  remaining: number;
}

/**
 * What to tell the user after a rescore stops.
 *
 * The one rule: a pass that left rows undone must SAY SO. Reporting "Rescored
 * 25 roles." after stopping with 60 to go reads as complete, and the user has
 * no other signal that their edit only reached part of their pipeline.
 */
export function rescoreSummary(totals: RescoreTotals): string {
  if (totals.rescored === 0 && totals.failed === 0 && totals.remaining === 0) {
    return "Nothing to rescore.";
  }

  const parts: string[] = [
    totals.rescored === 0
      ? "No roles were rescored"
      : `Rescored ${totals.rescored} role${totals.rescored === 1 ? "" : "s"}`,
  ];

  if (totals.failed > 0) {
    parts.push(
      `${totals.failed} could not be scored and kept ${
        totals.failed === 1 ? "its old score" : "their old scores"
      }`
    );
  }

  if (totals.remaining > 0) {
    parts.push(`${totals.remaining} still to do — run Rescore again to continue`);
  }

  return `${parts.join(" · ")}.`;
}
