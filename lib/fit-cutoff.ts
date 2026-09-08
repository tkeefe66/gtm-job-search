// The bar a role has to clear to stay in the pipeline.
//
// Measured rather than assumed: across 194 scored roles, every 1 and every 2
// the user ever touched was moved to Not Interested — ten for ten, none pursued
// past New. Below the bar, a role costs a rescore and a posting read and earns
// nothing.
//
// The cutoff acts on the score AFTER it is computed. Telling the model to
// answer only 3-5 was considered and rejected: it does not remove weak roles,
// it relabels them, and it destroys the very signal this file needs.

import type { JobStatusDef } from "@/lib/job-statuses";

/** Below this, a role that was actually read is filed away rather than kept. */
export const MIN_KEPT_FIT_SCORE = 3;

/**
 * Whether a freshly scored role should be filed away instead of left New.
 *
 * Two guards, both load-bearing:
 *
 * `wasRead` — a score computed WITHOUT the posting (the extraction's one-line
 * summary, or a row from before postings were readable) is not evidence the
 * role is weak. Those stay New and stay in the enrich queue, so the posting is
 * read before anything is decided about them. Without this, a role that only
 * missed ingest's per-run read budget would be filed on a blind number.
 *
 * `status` — a row the user has already moved is a row they have an opinion
 * about, and a rescore firing mid-conversation must not sweep it away.
 *
 * A score of 0 means scoreFit failed (it returns 0 rather than throwing), which
 * is a scoring failure, not a weak role.
 */
export function shouldAutoFile(opts: {
  score: number;
  wasRead: boolean;
  status: string;
}): boolean {
  if (!opts.wasRead) return false;
  if (opts.status !== "New") return false;
  return opts.score > 0 && opts.score < MIN_KEPT_FIT_SCORE;
}

/**
 * Where a filed role goes, chosen from the tenant's OWN status config.
 *
 * Statuses are user-editable — labels renamed, entries hidden or deleted — so a
 * hardcoded "Not Interested" would write a key their config may not contain,
 * which bucketFor could not place. The first terminal, non-hidden status in
 * config order is the destination, and `Posting Closed` is excluded however the
 * list is ordered: it is terminal, but it is a CLAIM about the posting — that
 * it is gone — and a weak role's posting is alive. Filing there would be a lie
 * the link checker would go on to act on.
 *
 * Null when there is nowhere to file, which is a real configuration: the row
 * then stays New rather than being given an invented status.
 */
export function autoFileStatus(statuses: JobStatusDef[]): string | null {
  const target = statuses.find(
    (s) => s.bucket === "terminal" && !s.hidden && s.key !== "Posting Closed"
  );
  return target?.key ?? null;
}
