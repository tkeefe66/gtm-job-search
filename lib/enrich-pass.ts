// Drives a whole enrich backfill: batch after batch until the thin rows drain,
// a batch reports failure, or the batch budget runs out.
//
// A function rather than a `for` loop in the component, for the reason
// runRescorePass records about itself: the loop's decisions — when to stop,
// what to keep when a batch fails — are the ones that cost money when they are
// wrong, and a loop inside a React component is reachable from no test here.

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

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/**
 * One sentence describing what a pass did.
 *
 * Composed here rather than in the banner's JSX for the reason
 * fitBrainRescoreOffer's comment records: wording hardcoded at the call site is
 * wording no test can see, and this one has to keep three outcomes distinct —
 * stored, read-but-empty, and never read at all. Folding the middle into the
 * first would make a systematic extraction failure look like a successful pass.
 */
export function summarizeEnrich(pass: EnrichPassResult): string {
  const parts: string[] = [];
  if (pass.enriched > 0) parts.push(`Read and stored ${plural(pass.enriched, "role")}.`);
  if (pass.empty > 0)
    parts.push(`${plural(pass.empty, "posting")} had nothing usable to store.`);
  if (pass.relinked > 0)
    parts.push(`Repaired ${plural(pass.relinked, "link")} on the way past.`);
  if (pass.unreadable > 0)
    parts.push(`${plural(pass.unreadable, "posting")} could not be read and were skipped.`);
  if (pass.failed > 0) parts.push(`${plural(pass.failed, "role")} failed.`);
  if (pass.blocked.length > 0)
    parts.push(`${plural(pass.blocked.length, "role")} were left alone — see below.`);
  if (parts.length === 0) parts.push("Nothing to read — every open role already has its posting stored.");
  // Stated last and always, so a pass that stopped early (its batch budget, a
  // spend ceiling) is never mistaken for one that finished.
  if (pass.remaining > 0) parts.push(`${pass.remaining} still to do.`);
  return parts.join(" ");
}
