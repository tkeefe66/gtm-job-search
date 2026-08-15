/**
 * When moving a role to "Applied" should stamp `jobs.applied_date`.
 *
 * `applied_date` was rendered on every row (components/RolesTable.tsx) and
 * written by NOTHING. The one function that stamped it — `updateJobStatus` in
 * app/actions/jobs.ts — had zero callers: every status write in the app goes
 * through `updateJob(id, { status })`, which does not touch the column. So the
 * field read blank forever and the bug was invisible, because a role with no
 * applied date renders identically to one that was never applied.
 *
 * Pure and separate from the action so the rule is testable. `"use server"`
 * forbids non-async exports, so nothing in app/actions/jobs.ts can be reached
 * from a test — the same constraint that put buildFitPrompt in lib/.
 */
export function appliedDatePatch(
  status: string,
  existing: string | null,
  today: string
): { applied_date?: string } {
  if (status !== "Applied") return {};
  // First answer wins. The date means "when did I apply", so a round trip
  // through Rejected and back must not rewrite it.
  if (existing) return {};
  return { applied_date: today };
}

/** Today as `YYYY-MM-DD`, the shape of the `date` column. */
export function todayStamp(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
