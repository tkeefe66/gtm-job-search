// How the "Check links" report groups the rows it could not decide.
//
// NO import of lib/supabase.ts, directly or transitively — this is reached from
// the "use client" RolesTable, and supabase pulls in `pg`. Same hazard
// documented at lib/job-statuses.ts and lib/never-live.ts.

/**
 * Why a row landed in the report instead of being decided.
 *
 * `ambiguous` — several postings on the board we found could be this role.
 * `empty` — a board matched this company's name but lists nothing at all.
 * `unresolved` — the row still points at a job board and no employer board
 *   could be found for it, so there was nothing to check the posting against.
 *
 * The first two were one bucket until a user read "could be more than one
 * posting on the employer's board", clicked through, and found a board with no
 * jobs on it. The sentence was false for that row, and the two cases call for
 * different checks. `unresolved` was not in the report at all — only a count in
 * its summary line — so the four rows it covered could be counted but never
 * seen.
 *
 * Only the first two are closable, and neither automatically: the board behind
 * them was found by GUESSING a slug from the company name. `unresolved` is not
 * closable at all — nothing about it suggests the role is gone. It means the
 * link could not be checked past, which is a different sentence.
 *
 * `likely-closed` is TWO weak signals together: the employer's own site refused
 * to be read at all, AND the board found for that company does not list the
 * title. Neither alone is worth showing — a 403 is routine and a guessed board
 * proves nothing — but together they were right eleven times out of eleven on
 * 2026-09-07, when a user checked openai.com rows by hand and found every one
 * redirecting to the general careers page. Still never auto-closed: the board
 * was a guess, and a human confirming is exactly the case the guardrail defers
 * to.
 */
export type UnclearReason = "ambiguous" | "empty" | "unresolved" | "likely-closed";

/**
 * Splits report rows by reason, preserving each group's original order.
 *
 * Generic and structural on purpose: the row type lives with the action that
 * builds it (`LinkRepairRow` in app/actions/link-health.ts), and importing that
 * here would drag a `"use server"` module into a client component's graph.
 *
 * Every reason gets a key, always an array. The banner renders
 * `group.length > 0`, so a reason that resolved to `undefined` would throw
 * rather than render nothing.
 */
export function splitUnclear<T extends { reason: UnclearReason }>(
  rows: T[]
): { ambiguous: T[]; empty: T[]; unresolved: T[]; likelyClosed: T[] } {
  return {
    ambiguous: rows.filter((r) => r.reason === "ambiguous"),
    empty: rows.filter((r) => r.reason === "empty"),
    unresolved: rows.filter((r) => r.reason === "unresolved"),
    likelyClosed: rows.filter((r) => r.reason === "likely-closed"),
  };
}

/**
 * Which report rows survive a bulk move.
 *
 * The rule is per-ROW, not per-report, and that distinction is the whole
 * defect this replaced: the component filtered the entire list down to the rows
 * that FAILED, so a clean move of six rows emptied the report and took three
 * untouched rows with it. A row is removed only when it was BOTH acted on and
 * saved — the ones that failed stay so the retry is one click, and the ones
 * nobody touched were never this button's business.
 *
 * Order is preserved: a list that reshuffles under the cursor after a click is
 * its own bug.
 */
export function remainingUnclear<T extends { id: string }>(
  rows: T[],
  attemptedIds: string[],
  failedIds: string[]
): T[] {
  const attempted = new Set(attemptedIds);
  const failed = new Set(failedIds);
  return rows.filter((r) => !attempted.has(r.id) || failed.has(r.id));
}
