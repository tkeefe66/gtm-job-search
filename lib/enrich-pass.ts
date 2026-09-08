// Drives a whole enrich backfill: batch after batch until the thin rows drain,
// a batch reports failure, or the batch budget runs out.
//
// A function rather than a `for` loop in the component, for the reason
// runRescorePass records about itself: the loop's decisions — when to stop,
// what to keep when a batch fails — are the ones that cost money when they are
// wrong, and a loop inside a React component is reachable from no test here.

import { formatReadingCost } from "@/lib/cost-estimate";
import type { EnrichBlockedRow, EnrichReport } from "@/lib/enrich-scope";

/**
 * The outright cap on batches in one pass.
 *
 * A second bound on top of "stop when nothing is left": no arithmetic bug in
 * the count, and no server that always claims work remains, can bill
 * indefinitely from one click.
 */
export const MAX_ENRICH_BATCHES = 20;

export interface EnrichTotals {
  enriched: number;
  empty: number;
  relinked: number;
  unreadable: number;
  failed: number;
  blocked: EnrichBlockedRow[];
  /** What the last batch said was still thin. */
  remaining: number;
}

export interface EnrichPassResult extends EnrichTotals {
  /** How many batches actually ran — the loop's own drain evidence. */
  batches: number;
  error?: string;
}

export async function runEnrichPass(opts: {
  runBatch: (args: { cursor?: string }) => Promise<EnrichReport>;
  /** Called after every batch, so a long pass is not a silent one. */
  onProgress?: (totals: EnrichTotals) => void;
  maxBatches?: number;
}): Promise<EnrichPassResult> {
  const budget = opts.maxBatches ?? MAX_ENRICH_BATCHES;
  const totals: EnrichTotals = {
    enriched: 0,
    empty: 0,
    relinked: 0,
    unreadable: 0,
    failed: 0,
    blocked: [],
    remaining: 0,
  };
  let batches = 0;
  let error: string | undefined;
  let cursor: string | undefined;

  for (let i = 0; i < budget; i++) {
    // Counted before the call, not after: a batch that threw still ran, and
    // still spent whatever it spent before failing.
    batches++;
    let res: EnrichReport;
    try {
      res = await opts.runBatch({ cursor });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      break;
    }
    // PRESENCE, not truthiness. A batch reporting `error: ""` — the
    // unreachable database — read as success would keep this loop paying for
    // batch after batch against a database that answers nothing. Totals earned
    // before the failure are kept; losing the count of work already paid for
    // is its own bug.
    if (res.error !== undefined) {
      error = res.error;
      totals.remaining = res.remaining;
      break;
    }

    totals.enriched += res.enriched;
    totals.empty += res.empty;
    totals.relinked += res.relinked;
    totals.unreadable += res.unreadable;
    totals.failed += res.failed;
    totals.blocked.push(...res.blocked);
    totals.remaining = res.remaining;
    opts.onProgress?.({ ...totals, blocked: [...totals.blocked] });

    // No cursor means the batch decided nothing — every row was blocked, or
    // there were none. Continuing would restart from the beginning and
    // re-examine the same rows until the budget ran out.
    if (res.cursor === null) break;
    if (res.remaining <= 0) break;
    cursor = res.cursor;
  }

  return { ...totals, batches, error };
}

export interface EnrichStatRow {
  label: string;
  value: number;
  /** Why this outcome happened, for the rows that are not wins. */
  note?: string;
}

/**
 * The banner's results table.
 *
 * Counts, not prose. The first version put five numbers in a sentence and then
 * listed two dozen blocked rows underneath, so the two things the user actually
 * needed — did it work, is it still going — were the hardest things on screen
 * to find. Composed here rather than in JSX for the reason rescorePromptQuestion
 * is: a table written in a component is a table no test in this repo can see.
 *
 * Zero is omitted except for "Stored", which always shows: a pass that stored
 * nothing must say so rather than rendering an empty table.
 */
export function enrichStatRows(pass: EnrichTotals): EnrichStatRow[] {
  const rows: EnrichStatRow[] = [{ label: "Stored", value: pass.enriched }];
  const add = (label: string, value: number, note?: string) => {
    if (value > 0) rows.push({ label, value, note });
  };
  add("Nothing to store", pass.empty, "the page was read but said nothing usable");
  add("Links repaired", pass.relinked);
  add(
    "Could not be read",
    pass.unreadable,
    "client-rendered postings, or a page that would not load"
  );
  add("Failed", pass.failed);
  add(
    "Left alone",
    pass.blocked.length,
    "reading these could have stored another posting's words"
  );
  add("Still to do", pass.remaining);
  // What the pass cost, from the rows that actually reached a model call. The
  // banner reported counts and never spend, which was the one number a user
  // driving the paging themselves had no way to see.
  const billed = pass.enriched + pass.empty;
  if (billed > 0) {
    rows.push({ label: "Cost", value: billed, note: `about ${formatReadingCost(billed)}` });
  }
  return rows;
}

/** How many rows a pass has DECIDED — every outcome, wins included. */
function decided(pass: EnrichTotals): number {
  return (
    pass.enriched + pass.empty + pass.unreadable + pass.failed + pass.blocked.length
  );
}

/**
 * The line shown while a pass is still running.
 *
 * A disabled button reading "Reading postings…" is indistinguishable from a
 * hung one, and a pass over sixty rows takes minutes. This says what has moved.
 */
export function enrichProgressLine(pass: EnrichTotals): string {
  const done = decided(pass);
  if (done === 0 && pass.remaining === 0) return "Starting…";
  return `${done} read, ${pass.remaining} to go`;
}

