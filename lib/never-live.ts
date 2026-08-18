// Which jobs the table never shows.
//
// NO import of lib/supabase.ts, directly or transitively — this is reached from
// the "use client" RolesTable through app/actions/jobs.ts, and supabase pulls
// in `pg`. Same hazard documented at lib/job-statuses.ts.

import type { Job } from "@/lib/types";

/**
 * Splits the rows the table shows from the ones it never does.
 *
 * The check is `!== true`, not `=== false`, and that direction is deliberate:
 * a row selected before the column existed arrives with `never_live`
 * undefined, and `=== false` would read that absent key as "not false" and
 * drop the row, while `!== true` correctly keeps it. The failure that shows a
 * row which should have been hidden is far cheaper than the one that hides a
 * live role with nothing on screen to explain where it went.
 *
 * Returns the COUNT rather than the hidden rows themselves. Nothing renders
 * them, and handing back an array invites a caller to start.
 */
export function partitionNeverLive(jobs: Job[]): {
  visible: Job[];
  hiddenCount: number;
} {
  const visible = jobs.filter((j) => j.never_live !== true);
  return { visible, hiddenCount: jobs.length - visible.length };
}
