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

/**
 * Stands in for a rescore failure that arrived with nothing to say — the
 * client-side twin of UNDESCRIBED_DB_ERROR, which lives in lib/settings-store
 * and cannot be imported here without dragging `pg` into the browser bundle.
 *
 * Same split of duties: DETECTION is presence (`error !== undefined`) at every
 * branch, DESCRIPTION is substituted only where the text is about to be shown.
 * A driver failure carrying an empty message otherwise renders "Rescore: " and
 * tells the user nothing.
 */
export const UNDESCRIBED_RESCORE_ERROR = "it failed without saying why";

/** What to show for a pass error, including one that came with no message. */
export function rescoreErrorText(error: string): string {
  return error || UNDESCRIBED_RESCORE_ERROR;
}

/** What rescoring `count` rows costs, rounded to whole cents for display. */
export function rescoreCostDollars(count: number): number {
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.round(count * DOLLARS_PER_RESCORE * 100) / 100;
}

/**
 * Why the rescore offer is on screen — which decides what it may claim.
 *
 * - "edit": the user just saved something that changed scoring, so the prompt
 *   can say so.
 * - "comp-scoring": nobody saved anything; compensation joined fit scoring on
 *   DEPLOY, and the offer is firing on a bare page load.
 * - "fit-brain": nobody saved anything this session either, but a customized
 *   fit brain is stored, so the scores may not match it.
 * - "onboarding": a RE-RUN of onboarding just replaced the fit brain, its
 *   tails, title scope and domain bonus wholesale — every row scored under
 *   the previous career is now stale. Unlike the other three this one has no
 *   server stamp: components/Onboarding.tsx unmounts the moment Finish
 *   navigates to /discover, so there is no later page load for a stamp to
 *   gate — the offer either fires now, in the same render that knows a save
 *   just happened, or never.
 */
type RescoreReasonKind = "edit" | "comp-scoring" | "fit-brain" | "onboarding";

declare const REASON_BRAND: unique symbol;

/**
 * BRANDED on purpose: `reason="edit"` cannot be written at a call site, inside
 * RescorePrompt, or in rescorePromptQuestion's own body, because a bare string
 * literal is not assignable to this type. `rescoreOffers` below is the only
 * producer.
 *
 * That is not decoration. A review of this component's wiring planted six
 * mutants and all six shipped green; the two that mattered were a call site and
 * the component each hardcoding "edit", which silently reverts the day-one
 * prompt to claiming a save happened and that the scores predate an edit —
 * both false, and neither observable from any test this repo supports. Those
 * two are now compile errors instead. The brand is the only mechanism that
 * reaches inside a React component here, since the components are not unit
 * tested.
 */
export type RescoreReason = RescoreReasonKind & { readonly [REASON_BRAND]: true };

const reason = (kind: RescoreReasonKind) => kind as RescoreReason;

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
  if (input.floorEditedThisSession) return reason("edit");
  return input.compScoringRescoredAt === null ? reason("comp-scoring") : null;
}

export interface FitBrainRescoreOfferInput {
  scoredJobCount: number;
  /** Is a fit brain of the user's own stored, rather than the shipped one? */
  fitBrainOverridden: boolean;
  /** Did the user save or reset the fit brain in THIS session? */
  fitBrainEditedThisSession: boolean;
  dismissed: boolean;
}

/**
 * The same decision for the fit-brain section, and in the same shape: server
 * state (is a custom brain stored?) with the session flag OR-ed in, so the
 * flag can only ADD the reset case — a reset DELETES the row, which turns
 * `fitBrainOverridden` back off — and never remove the server-driven one.
 *
 * Out here for the second reason too: it decides the WORDING, and the version
 * of this that shipped had none. It rendered "Saved." on a bare page load
 * where nothing had been saved and nothing in the session had been touched,
 * because the copy was hardcoded in the component. There is no stamp for the
 * fit brain (nothing records when it was last rescored against), so on a bare
 * load this can say only that a custom brain exists — not that any particular
 * score predates it.
 */
export function fitBrainRescoreOffer(
  input: FitBrainRescoreOfferInput
): RescoreReason | null {
  if (input.dismissed) return null;
  if (input.scoredJobCount <= 0) return null;
  if (input.fitBrainEditedThisSession) return reason("edit");
  return input.fitBrainOverridden ? reason("fit-brain") : null;
}

export interface OnboardingRescoreOfferInput {
  /** Rows carrying a fit score, read fresh after saveProfile commits. */
  scoredJobCount: number;
  /**
   * Was this tenant already onboarded when THIS run started? A first run has
   * nothing to rescore — every job that could be stale does not exist yet,
   * because nothing could be scored before a profile existed at all.
   */
  wasAlreadyOnboarded: boolean;
  dismissed: boolean;
}

/**
 * Whether to offer a rescore right after Finish saves a re-run.
 *
 * Out here for the usual reason: this repo does not unit-test React, and the
 * `wasAlreadyOnboarded` guard is exactly the kind of clause that is invisible
 * from inside a component and easy to drop by accident — dropping it would
 * offer to rescore zero rows on every first-time onboarding, which is
 * harmless but wrong, or worse, would be the only thing standing between a
 * correct gate and one that fires before saveProfile's own commit is even
 * read back.
 */
export function onboardingRescoreOffer(
  input: OnboardingRescoreOfferInput
): RescoreReason | null {
  if (input.dismissed) return null;
  if (!input.wasAlreadyOnboarded) return null;
  if (input.scoredJobCount <= 0) return null;
  return reason("onboarding");
}

/**
 * The slice of SettingsView both offers read.
 *
 * Structural rather than a list of scalar parameters so the settings page
 * passes `view` WHOLE. There are then no per-field arguments at the call site
 * to mis-wire — one of the planted wiring mutants handed the gate a different
 * `string` field of the view, which type-checked and shipped green. Passing
 * the object closes that: the field names are matched by the compiler, and a
 * rename in SettingsView breaks the call rather than silently rewiring it.
 */
export interface RescoreOfferView {
  scoredJobCount: number;
  fitBrainOverridden: boolean;
  compScoringRescoredAt: string | null;
}

/** What the user has done in this page load. */
export interface RescoreOfferSession {
  fitBrainEditedThisSession: boolean;
  floorEditedThisSession: boolean;
  /** One dismissal covers both offers — one pass fixes whatever went stale. */
  dismissed: boolean;
}

export interface RescoreOffers {
  /** Shown in the fit-brain section, or null. */
  fitBrain: RescoreReason | null;
  /** Shown in the compensation section, or null. */
  compensation: RescoreReason | null;
}

/**
 * Both offers, decided in one place.
 *
 * The settings page holds no gate logic and writes no reason literal of its
 * own: it renders whatever this returns. That is what makes the rules
 * testable — this repo does not unit-test React — and, with the brand on
 * RescoreReason, what makes a hardcoded wording at either call site a compile
 * error rather than a green regression.
 */
export function rescoreOffers(
  view: RescoreOfferView,
  session: RescoreOfferSession
): RescoreOffers {
  return {
    fitBrain: fitBrainRescoreOffer({
      scoredJobCount: view.scoredJobCount,
      fitBrainOverridden: view.fitBrainOverridden,
      fitBrainEditedThisSession: session.fitBrainEditedThisSession,
      dismissed: session.dismissed,
    }),
    compensation: compRescoreOffer({
      scoredJobCount: view.scoredJobCount,
      compScoringRescoredAt: view.compScoringRescoredAt,
      floorEditedThisSession: session.floorEditedThisSession,
      dismissed: session.dismissed,
    }),
  };
}

/**
 * The prompt's question, dollar figure included.
 *
 * Here rather than in the JSX so the two wordings can be pinned by tests, and
 * so the figure keeps coming from rescoreCostDollars — no caller anywhere,
 * including the component, gets to supply a number that disagrees with what the
 * pass bills.
 *
 * The "comp-scoring" and "fit-brain" wordings are deliberately hedged. There is
 * no version column (the no-migration constraint ruled one out) and no
 * per-brain stamp, so nothing here knows which rows predate anything — some may
 * have been scored yesterday with compensation and the current brain already in
 * the prompt. "may not reflect it" is the most either can honestly say. Neither
 * may open with "Saved.": on those two paths nothing was saved.
 *
 * `why`, not `reason`, because `reason` is the name of the branded-value
 * constructor above; shadowing it here would make a hardcoded literal inside
 * this function compile again.
 */
export function rescorePromptQuestion(why: RescoreReason, count: number): string {
  const dollars = rescoreCostDollars(count).toFixed(2);
  const roles = `${count} role${count === 1 ? "" : "s"}`;
  const them = count === 1 ? "it" : "them";

  if (why === "comp-scoring") {
    return (
      `Compensation is now part of fit scoring. ${roles} ` +
      `${count === 1 ? "has a score" : "have scores"} that may not reflect it. ` +
      `Rescore ${them} for about $${dollars}?`
    );
  }
  if (why === "fit-brain") {
    return (
      `Your fit brain is customized. ${roles} ` +
      `${count === 1 ? "has a score" : "have scores"} that may not reflect it. ` +
      `Rescore ${them} for about $${dollars}?`
    );
  }
  if (why === "onboarding") {
    return (
      `Saved. Your profile changed, and ${roles} ` +
      `${count === 1 ? "carries a score" : "carry scores"} from before this edit. ` +
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
 *
 * A null `remaining` (the count query failed — see RescoreTotals) also stops
 * the loop. Continuing on a number nobody can verify is how a client loop
 * bills indefinitely; the user clicks Rescore again instead.
 */
export function shouldContinueRescore(result: {
  rescored: number;
  remaining: number | null;
}): boolean {
  if (result.remaining === null) return false;
  return result.remaining > 0 && result.rescored > 0;
}

/**
 * Whether a pass finished ALL the work — the only condition under which the
 * offer may be switched off permanently.
 *
 * Out here rather than inline in the component because of a defect this exact
 * expression used to hide. `remaining` was typed `number` and the action
 * returned `0` when its count query failed, which is indistinguishable from a
 * genuinely drained pass. 100 stale rows, 25 rescored, one blip on the count
 * query, and this read "drained": the permanent stamp got written, 75 rows
 * stayed stale forever, and the only thing the user saw was "Rescored 25
 * roles." That was survivable while the consequence was a session-scoped
 * dismissal a reload undid; a stamp in app_settings made it permanent.
 *
 * So `remaining` is `number | null` at the boundary, and only a KNOWN zero
 * counts. Unknown leaves the offer standing — the same asymmetry applied to
 * the failed settings read: a redundant offer costs one dismissal, a wrongly
 * suppressed one loses rows silently. Not encoded as a sentinel integer; a
 * second magic number in this area is how the original bug happened.
 */
export function passDrained(pass: {
  rescored: number;
  remaining: number | null;
  error?: string;
}): boolean {
  if (pass.error !== undefined) return false;
  if (pass.remaining === null) return false;
  return pass.rescored > 0 && pass.remaining === 0;
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
  /**
   * Scored rows this pass has not finished, or **null when that could not be
   * counted**. Null is not "none": the count is its own query and it fails on
   * its own. Typed rather than folded into 0 because 0 is the one value that
   * authorizes switching the offer off for good — see passDrained.
   */
  remaining: number | null;
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
  // Starts at 0 so a pass that never reached a batch reads as "nothing left",
  // which is true — no rows were touched and none are outstanding FROM it. Any
  // batch that runs overwrites this with its own answer, null included.
  let remaining: number | null = 0;
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
    // PRESENCE, not truthiness. A batch reporting `error: ""` was swallowed
    // here: `pass.error` came back undefined, passDrained then returned TRUE,
    // and the pass stamped. It also filtered out exactly the input passDrained's
    // own empty-error test exists to guard, so the two halves disagreed. Not
    // reachable through rescoreAll today — every error string there is a
    // non-empty template — but this is the fourth time this class has bitten
    // this project, and the driver's empty message is where it comes from.
    if (res.error !== undefined) {
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
    //
    // shouldContinueRescore has already returned false for a null `remaining`,
    // so the loop broke above; this line is only reached with a real count.
    limit = Math.min(batchSize, remaining ?? batchSize);
  }

  return { rescored, failed, remaining, batches, error };
}

/**
 * What to tell the user after a rescore stops.
 *
 * The one rule: a pass that left rows undone must SAY SO. Reporting "Rescored
 * 25 roles." after stopping with 60 to go reads as complete, and the user has
 * no other signal that their edit only reached part of their pipeline.
 *
 * A null `remaining` gets the same treatment for the same reason. "Rescored 25
 * roles." when nobody knows whether 0 or 75 are left reads as complete too —
 * and that silence was the whole visible symptom of the bug passDrained now
 * closes.
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

  if (totals.remaining === null) {
    parts.push(
      "how many are left could not be counted — run Rescore again to be sure"
    );
  } else if (totals.remaining > 0) {
    parts.push(`${totals.remaining} still to do — run Rescore again to continue`);
  }

  return `${parts.join(" · ")}.`;
}
