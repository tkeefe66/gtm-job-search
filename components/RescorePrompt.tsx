"use client";

import { rescoreCostDollars } from "@/lib/rescore-progress";

/**
 * The offer to re-score existing roles against an edited fit brain.
 *
 * A component rather than inline markup in Settings.tsx because the companion
 * compensation plan shows the same prompt after a comp-floor edit, and two
 * copies of this copy would drift — most importantly on the dollar figure.
 *
 * It derives that figure from `count` itself rather than taking one as a prop,
 * so DOLLARS_PER_RESCORE has exactly one home (lib/rescore-progress.ts) and a
 * caller cannot quote a number that disagrees with what the run bills.
 *
 * `busy` comes from the caller because the caller owns the loop over
 * rescoreAll's batches; the label for it is owned here.
 */
export default function RescorePrompt({
  count,
  onRescore,
  onDismiss,
  busy,
}: {
  count: number;
  onRescore: () => void;
  onDismiss: () => void;
  busy: boolean;
}) {
  const dollars = rescoreCostDollars(count);

  return (
    <div className="mt-3 rounded-md border border-[#92400E]/30 bg-[#92400E]/5 p-3">
      <p className="text-sm text-ink/70">
        Saved. {count} role{count === 1 ? "" : "s"}{" "}
        {count === 1 ? "carries" : "carry"} scores from before this edit. Rescore
        {count === 1 ? " it" : " them"} for about ${dollars.toFixed(2)}?
      </p>
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
