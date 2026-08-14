"use client";

import { rescorePromptQuestion, type RescoreReason } from "@/lib/rescore-progress";

/**
 * The offer to re-score existing roles whose scores are stale.
 *
 * A component rather than inline markup in Settings.tsx because it is shown
 * from three places now — a fit-brain edit, a comp-floor edit, and the
 * compensation offer that fires on a bare page load — and three copies of this
 * copy would drift, most importantly on the dollar figure.
 *
 * The wording and that figure both come from rescorePromptQuestion, which
 * derives the dollars from `count` through rescoreCostDollars. Neither is a
 * prop: DOLLARS_PER_RESCORE keeps exactly one home (lib/rescore-progress.ts),
 * no caller can quote a number that disagrees with what the run bills, and the
 * two wordings stay testable — this component is not.
 *
 * `reason` is a closed union rather than a free-text lead, so the load-time
 * case cannot inherit the edit case's "Saved." (nothing was saved) or its
 * claim that the scores predate the change (nothing knows that — there is no
 * version column).
 *
 * `busy` comes from the caller because the caller owns the loop over
 * rescoreAll's batches; the label for it is owned here.
 */
export default function RescorePrompt({
  count,
  reason,
  onRescore,
  onDismiss,
  busy,
}: {
  count: number;
  reason: RescoreReason;
  onRescore: () => void;
  onDismiss: () => void;
  busy: boolean;
}) {
  return (
    <div className="mt-3 rounded-md border border-[#92400E]/30 bg-[#92400E]/5 p-3">
      <p className="text-sm text-ink/70">{rescorePromptQuestion(reason, count)}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          onClick={onRescore}
          disabled={busy}
          className="rounded-md border border-ink bg-ink px-3 py-1.5 text-sm font-medium text-white transition hover:bg-ink/90 disabled:opacity-50"
        >
          {/* Honest about the wait: rescoreAll makes one Claude call per row,
              sequentially, and this runs in the foreground. */}
          {busy ? `Rescoring ${count} roles… (about a minute)` : "Rescore"}
        </button>
        <button
          onClick={onDismiss}
          disabled={busy}
          className="text-sm text-ink/40 transition hover:text-ink disabled:opacity-50"
        >
          Not now
        </button>
      </div>
    </div>
  );
}
