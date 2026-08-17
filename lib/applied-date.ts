import type { SystemStatusKey } from "@/lib/job-statuses";

/**
 * When moving a role to "Applied" should stamp `jobs.applied_date`.
 *
 * `applied_date` was rendered in the expanded row detail
 * (components/RolesTable.tsx) and written by NOTHING. The one function that
 * stamped it — `updateJobStatus` in app/actions/jobs.ts — had zero callers:
 * every status write in the app goes through `updateJob(id, { status })`, which
 * does not touch the column. So the field read blank forever and the bug was
 * invisible, because a role with no applied date renders identically to one
 * that was never applied.
 *
 * Pure and separate from the action so the rule is testable. `"use server"`
 * forbids non-async exports, so nothing in app/actions/jobs.ts can be reached
 * from a test — the same constraint that put buildFitPrompt in lib/.
 */

/**
 * The status this rule keys on, named rather than inlined.
 *
 * The PARAMETER is now `string`, because the user can add statuses and this
 * function must be reachable with any of their keys. The safety did not move
 * far: `APPLIED` is still typed, now as SystemStatusKey, so dropping "Applied"
 * from the system set is still a compile error here. And the hazard the old
 * `JobStatus` parameter guarded — a RENAME silently stopping the stamp — cannot
 * happen any more by construction: renaming edits the label, never the key, and
 * the key is what jobs.status stores and what arrives here.
 */
const APPLIED: SystemStatusKey = "Applied";

export function appliedDatePatch(
  status: string,
  existing: string | null,
  today: string
): { applied_date?: string } {
  if (status !== APPLIED) return {};
  // First answer wins. The date means "when did I apply", so a round trip
  // through Rejected and back must not rewrite it. Note this returns {} rather
  // than clearing: moving OUT of Applied must also leave the date alone.
  if (existing) return {};
  return { applied_date: today };
}

/**
 * Today as `YYYY-MM-DD` in the VIEWER'S timezone, which is the shape of the
 * `date` column.
 *
 * Deliberately not `toISOString().slice(0, 10)`. That is UTC, and this string
 * is rendered on the same line as `roleAge`'s dates (lib/role-age.ts), which
 * format with `toLocaleDateString` — browser-local. In Denver (UTC-6) at 6:30pm
 * the two disagree: a role found "today, Aug 15" renders `applied 2026-08-16`.
 * It never self-corrects, because the optimistic value and the stored value are
 * the same wrong string. The symmetric error exists east of Greenwich, where an
 * early-morning apply stamps yesterday.
 *
 * Every other date surface in this repo is local or raw-from-Postgres —
 * lib/supabase.ts pins OID 1082 to the raw 'YYYY-MM-DD' string specifically to
 * avoid a timezone shift. This is the one place that manufactures a date, so it
 * has to manufacture the same one the user is looking at.
 *
 * Built from the local getters rather than a locale format, so the output can
 * never depend on the viewer's locale settings.
 */
export function todayStamp(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
