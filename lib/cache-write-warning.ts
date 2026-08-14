// What to say when a billed Claude result could not be cached.
//
// Every "search" feature in this app pays Anthropic per web search and then
// writes the result to a `*_cache` / `discovered_*` table so the next view is
// free. When that write fails and nobody looks at the result, the search is
// silently re-billed on every subsequent click, forever, with nothing
// connecting the two. app/actions/role-search.ts called a discarded error here
// "the most expensive silence in this file" and built this message inline; the
// three sibling paths (roles, discover, insights) discarded theirs entirely.
//
// The message lives out here, pure, so all four say the same thing and so the
// one detail that actually gets the user unstuck — the schema command — cannot
// drift out of one copy of it.

import { UNDESCRIBED_DB_ERROR } from "@/lib/write-failure";

/**
 * "12 roles" / "1 role" / "0 roles".
 *
 * Trivial, and pinned by a test anyway: the singular case is exactly the sort
 * of thing that gets written once correctly and then copied wrong into the
 * next three call sites, which is the situation this module exists to end.
 */
export function countPhrase(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export interface CacheWriteWarningInput {
  /**
   * What the billed call produced — completes "___, but saving it to the ...
   * cache failed". E.g. "Found 12 roles" or "The pipeline analysis finished".
   */
  produced: string;
  /** The table the write targeted. Named twice: in the failure and in the fix. */
  table: string;
  /**
   * The driver's message, VERBATIM — empty string included. Substitution
   * happens here, at the point of display, never at the transport. See
   * lib/write-failure.ts.
   */
  error: string;
}

/**
 * The user-facing warning for a failed cache write after a billed search.
 *
 * Three things, in the order the user needs them: what happened, what it costs
 * if ignored, and the single command that fixes the overwhelmingly most likely
 * cause. That last part is not padding — the first thing that happens on a
 * deploy without `node db/apply-schema.mjs` is that these tables do not exist,
 * which is a statement-level error with a perfectly good message that nobody
 * was reading.
 *
 * Reported, never thrown. The results were paid for and must still reach the
 * user; see shouldReplaceRoleView in lib/role-search-cache.ts for how a result
 * that carries a payload keeps its place on screen alongside this warning.
 */
export function cacheWriteWarning(input: CacheWriteWarningInput): string {
  return (
    `${input.produced}, but saving to the ${input.table} cache failed — ` +
    `${input.error || UNDESCRIBED_DB_ERROR}. The results are live and were NOT saved, so ` +
    `the next run repeats every Claude search this one already paid for and is re-billed ` +
    `in full. If the ${input.table} table is missing, apply the schema: ` +
    `DATABASE_URL=... node db/apply-schema.mjs`
  );
}
