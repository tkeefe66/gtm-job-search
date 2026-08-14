// What "removing a target title" costs, in rows the user can already see.
//
// Editing the title list is the least obvious edit on the settings page: it
// changes what the weekly crawler hunts for on every tracked company and what
// Find roles searches for. A static "this affects the crawler" note does not
// convey that — a count does. This file holds the pure half (which titles are
// going away, and the query that counts the rows they match); the database
// half is countCrawlJobsMatchingTitles in app/actions/settings.ts.

import { normalizeList } from "@/lib/criteria-validation";

/**
 * Titles present in `saved` but absent from `draft`, in saved order and with
 * the saved spelling.
 *
 * Compared case-insensitively on normalized text, the same way normalizeList
 * de-duplicates, so re-casing or re-spacing a title ("revops lead" →
 * "RevOps Lead") is an edit, not a removal followed by an addition. A genuine
 * rename IS a removal: the old title stops being crawled for, which is exactly
 * what the warning needs to say.
 */
export function removedTitles(saved: string[], draft: string[]): string[] {
  const kept = new Set(normalizeList(draft).map((t) => t.toLowerCase()));
  return normalizeList(saved).filter((t) => !kept.has(t.toLowerCase()));
}

/**
 * Escapes the three characters Postgres' LIKE grammar reserves. Without this a
 * stack term or title containing `_` — common in scraped titles — would match
 * any single character, and one containing `%` would match everything, which
 * turns the warning's count into a number far larger than the truth.
 *
 * Backslash is escaped by the same pass, not a separate one: a second
 * `.replace` over the output would double-escape the backslashes the first
 * pass just added.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * ILIKE patterns for a set of titles.
 *
 * Substring rather than equality on purpose. A crawler-found `role_title` is
 * whatever the posting called it ("Director of Revenue Operations, EMEA"),
 * never the exact criteria entry, so `=` would report 0 for every real edit
 * and the warning would always read "0 tracked roles".
 */
export function titleMatchPatterns(titles: string[]): string[] {
  return normalizeList(titles).map((t) => `%${escapeLike(t)}%`);
}

/**
 * How many rows on /roles the crawler will stop refreshing.
 *
 * The two predicates are the same pair STALE_POSTING_CANDIDATES_SQL in
 * lib/crawler.ts uses, and for the same reasons: `source = 'Crawl'` because a
 * role the user found through Find roles or entered by hand was never
 * title-matched by the crawler, and `status = 'New'` because a row the user
 * has moved into their pipeline is theirs and does not belong in a warning
 * about crawler coverage.
 *
 * Exported so the scoping decision can be pinned by a string-content test
 * without a database.
 */
export const CRAWL_TITLE_MATCH_SQL = `select count(*) n from jobs
      where source = 'Crawl'
        and status = 'New'
        and role_title ilike any($1::text[])`;

/** The exact sentence the titles section shows. Copy lives here so it is pinned. */
export function removedTitlesWarning(count: number): string {
  const roles = count === 1 ? "1 tracked role matches" : `${count} tracked roles match`;
  return (
    `${roles} titles you are removing. They stay on /roles, and the crawler ` +
    `will stop monitoring them.`
  );
}
