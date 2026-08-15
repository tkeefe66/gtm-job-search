// The pure half of bulk status changes on /roles.
//
// Import-free apart from lib/write-failure.ts, which is itself import-free —
// this is reached from a `"use client"` component, so anything that
// transitively pulls in lib/supabase.ts (and with it `pg`) would break the
// browser bundle.

import { UNDESCRIBED_DB_ERROR } from "./write-failure";

/**
 * The selected rows that are actually on screen, in display order.
 *
 * Selection is a Set of ids that outlives filtering: tick three roles, then
 * type in the search box, and two of them can disappear while their ids stay
 * in the Set. Intersecting with the visible list at USE time (rather than
 * pruning the Set whenever the filter changes) means a bulk write can never
 * touch a row the user cannot see, and re-widening the filter brings the
 * earlier ticks back rather than silently losing them.
 */
export function selectionInView<T extends { id: string }>(
  visible: T[],
  selected: Set<string>
): T[] {
  return visible.filter((row) => selected.has(row.id));
}

export interface BulkWriteResult {
  id: string;
  error?: string;
}

export interface BulkStatusFailure {
  /** Rows whose write failed — the caller rolls exactly these back. */
  failedIds: string[];
  /** One sentence for the banner. */
  message: string;
}

/**
 * Turns a batch of `{ error?: string }` results into one sentence, or null when
 * every write landed.
 *
 * DETECTION IS PRESENCE (`!== undefined`), never truthiness: `pg` rejects with
 * an `AggregateError` whose message is the empty string whenever every address
 * of a dual-stack host refuses — the unreachable-DATABASE_URL case — so a
 * truthiness check would count the worst failure this app has as a success and
 * leave the optimistic rows on screen looking saved. Description substitutes
 * UNDESCRIBED_DB_ERROR only here, where the text is about to be shown.
 *
 * One sentence for the whole batch, not one per row: N failing rows have one
 * cause (the database is down), and N banners would say the same thing N times.
 */
export function summarizeBulkStatus(
  results: BulkWriteResult[],
  status: string
): BulkStatusFailure | null {
  const failed = results.filter((r) => r.error !== undefined);
  if (failed.length === 0) return null;

  const reason = failed[0].error || UNDESCRIBED_DB_ERROR;
  const saved = results.length - failed.length;
  const message =
    saved === 0
      ? `Could not move ${count(failed.length)} to "${status}" — ${reason}`
      : `Moved ${saved} of ${results.length} roles to "${status}", but ` +
        `${failed.length} could not be saved — ${reason}`;

  return { failedIds: failed.map((r) => r.id), message };
}

function count(n: number): string {
  return `${n} ${n === 1 ? "role" : "roles"}`;
}
