// How the "Check links" report groups the rows it could not decide.
//
// NO import of lib/supabase.ts, directly or transitively — this is reached from
// the "use client" RolesTable, and supabase pulls in `pg`. Same hazard
// documented at lib/job-statuses.ts and lib/never-live.ts.

/**
 * Why a row landed in the report instead of being closed.
 *
 * `ambiguous` — several postings on the employer's board could be this role.
 * `empty` — a board exists under the company's slug but lists nothing at all.
 *
 * These were one bucket until a user read "could be more than one posting on
 * the employer's board", clicked through, and found a board with no jobs on it.
 * The sentence was false for that row, and the two cases call for different
 * checks: an ambiguous match is read against the board's postings, while an
 * empty board is read against the company's real careers page, because the
 * board was found by GUESSING a slug and may not be theirs at all.
 */
export type UnclearReason = "ambiguous" | "empty";

/**
 * Splits report rows by reason, preserving each group's original order.
 *
 * Generic and structural on purpose: the row type lives with the action that
 * builds it (`LinkRepairRow` in app/actions/link-health.ts), and importing that
 * here would drag a `"use server"` module into a client component's graph.
 */
export function splitUnclear<T extends { reason: UnclearReason }>(
  rows: T[]
): { ambiguous: T[]; empty: T[] } {
  return {
    ambiguous: rows.filter((r) => r.reason === "ambiguous"),
    empty: rows.filter((r) => r.reason === "empty"),
  };
}
