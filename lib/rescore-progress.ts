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
 * Why the rescore offer is on screen — which decides what it may claim.
 *
 * "edit": the user just saved something that changed scoring, so the prompt can
 * say so. "comp-scoring": nobody saved anything; compensation joined fit
 * scoring on DEPLOY, and the offer is firing on a bare page load.
 */
export type RescoreReason = "edit" | "comp-scoring";

export interface CompRescoreOfferInput {
  /** Rows carrying a fit score, from the settings view. */
  scoredJobCount: number;
  /** When a compensation rescore pass last completed, or null if never. */
  compScoringRescoredAt: string | null;
  /** Did the user save the comp floor in THIS session? */
  floorEditedThisSession: boolean;
  /** Did the user wave the offer off in this session? */
  dismissed: boolean;
}

/**
 * Whether to offer a rescore in the compensation section, and in whose words.
 * Null means "do not show it".
 *
 * Out here rather than as an expression in Settings.tsx because this repo does
 * not unit-test React components, and every clause below is a rule that has a
 * wrong version worth pinning:
 *
 * - The SERVER stamp is the load-bearing gate, not the session flag. A client
 *   component has no memory across page loads, so a session-only rule shows the
 *   offer to nobody on the day it matters most: the deploy that made every
 *   stored score stale involves no user edit at all. The session flag is OR-ed
 *   in exactly as fitBrainTouchedHere is — it can only ADD the case where the
 *   user re-edits the floor after a pass has already been stamped, never remove
 *   the server-driven one.
 * - `scoredJobCount > 0` cannot be the trigger by itself: rescoring updates
 *   scores rather than removing them, so that count survives a successful pass
 *   unchanged and the offer would return immediately, forever. The stamp is
 *   what suppresses it.
 * - The session flag wins the WORDING when both apply. The user who just
 *   clicked Save is owed "Saved."; the user who just opened the page is not.
 */
export function compRescoreOffer(input: CompRescoreOfferInput): RescoreReason | null {
  if (input.dismissed) return null;
  // Nothing scored means nothing to rescore, and a prompt offering to spend
  // $0.00 on zero roles.
  if (input.scoredJobCount <= 0) return null;
  if (input.floorEditedThisSession) return "edit";
  return input.compScoringRescoredAt === null ? "comp-scoring" : null;
}

/**
 * The prompt's question, dollar figure included.
 *
 * Here rather than in the JSX so the two wordings can be pinned by tests, and
 * so the figure keeps coming from rescoreCostDollars — no caller anywhere,
 * including the component, gets to supply a number that disagrees with what the
 * pass bills.
 *
 * The "comp-scoring" wording is deliberately hedged. There is no version column
 * (the no-migration constraint ruled one out), so nothing here knows which rows
 * predate the change — some may have been scored yesterday with compensation
 * already in the prompt. "may not reflect it" is the most this can honestly
 * say. It also must not open with "Saved.": nothing was saved.
 */
export function rescorePromptQuestion(reason: RescoreReason, count: number): string {
  const dollars = rescoreCostDollars(count).toFixed(2);
  const roles = `${count} role${count === 1 ? "" : "s"}`;
  const them = count === 1 ? "it" : "them";

  if (reason === "comp-scoring") {
    return (
      `Compensation is now part of fit scoring. ${roles} ` +
      `${count === 1 ? "has a score" : "have scores"} that may not reflect it. ` +
      `Rescore ${them} for about $${dollars}?`
    );
  }
  return (
    `Saved. ${roles} ${count === 1 ? "carries" : "carry"} scores from before ` +
    `this edit. Rescore ${them} for about $${dollars}?`
  );
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

/** What one call of the rescore action reports back. */
export interface RescoreBatchResult extends RescoreTotals {
  /**
   * The pass timestamp the batch counted `remaining` against. The FIRST batch
   * mints it (server-side, so no browser clock is involved); every later batch
   * must be handed the same one back.
   */
  passStartedAt?: string;
  error?: string;
}

export interface RescorePassResult extends RescoreTotals {
  /** How many batches actually ran — the loop's own drain evidence. */
  batches: number;
  error?: string;
}

/**
 * Drives a whole rescore pass: batch after batch until the work drains, the
 * budget runs out, or a batch reports failure.
 *
 * THE reason this is a function and not a `for` loop in the component: the
 * pass timestamp must be taken ONCE and threaded into every batch. Taken per
 * batch instead, `remaining` counts the previous batches' finished rows as
 * still outstanding — it never reaches zero, the loop keeps buying full extra
 * passes (26 scored rows cost 75 scoreFit calls), and the caller is told there
 * is work left after doing all of it. That defect exists only ACROSS batches,
 * so it cannot be seen from inside a single call, and a loop living in a React
 * component cannot be tested at all in this repo. Out here, a fake batch
 * source pins it (lib/rescore-progress.test.ts).
 *
 * Two independent bounds, both kept: `shouldContinueRescore` requires real
 * forward progress, and `maxRescoreBatches` caps the batch count outright so
 * no arithmetic bug can bill indefinitely.
 *
 * Never throws. A rejected batch is captured as `error` with the totals earned
 * so far intact — losing the count of work already paid for is its own bug.
 */
export async function runRescorePass(opts: {
  /** Rows the page believes are scored — sizes the batch budget only. */
  total: number;
  runBatch: (args: {
    passStartedAt?: string;
    limit?: number;
  }) => Promise<RescoreBatchResult>;
  /** Called after every successful batch, so a long pass is not a silent one. */
  onProgress?: (totals: RescoreTotals) => void;
  batchSize?: number;
}): Promise<RescorePassResult> {
  const batchSize = opts.batchSize ?? DEFAULT_RESCORE_LIMIT;
  const budget = maxRescoreBatches(opts.total, batchSize);

  let rescored = 0;
  let failed = 0;
  let remaining = 0;
  let batches = 0;
  let error: string | undefined;
  // Pinned by the first batch that returns one, then handed to every batch
  // after it. Undefined on the first call: the server mints it there.
  let passStartedAt: string | undefined;
  // Undefined on the first call, so the action applies its own default.
  let limit: number | undefined;

  for (let i = 0; i < budget; i++) {
    // Counted before the call, not after: a batch that threw still ran, and
    // still spent whatever it spent before failing.
    batches++;
    let res: RescoreBatchResult;
    try {
      res = await opts.runBatch({ passStartedAt, limit });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      break;
    }
    if (res.error) {
      error = res.error;
      break;
    }
    if (passStartedAt === undefined) passStartedAt = res.passStartedAt;

    rescored += res.rescored;
    failed += res.failed;
    remaining = res.remaining;
    opts.onProgress?.({ rescored, failed, remaining });

    if (!shouldContinueRescore(res)) break;

    // Ask the NEXT batch for only what is actually left. The batch query is
    // "the oldest `limit` scored rows", and rows this pass has finished carry
    // the newest timestamps — so a full-size batch with 1 row outstanding
    // re-scores 24 rows it already did, at ~$0.0076 each, and reports them as
    // rescores. Untouched rows are always the oldest, so a limit of
    // `remaining` selects exactly them.
    limit = Math.min(batchSize, remaining);
  }

  return { rescored, failed, remaining, batches, error };
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
