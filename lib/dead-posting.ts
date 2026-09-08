// Detecting a posting that says it is gone while its server says 200.
//
// Aggregators serve SOFT 404s, and checkJobUrl only closes on a definitive
// 404/410, so those rows sit as New forever: a real BuiltIn page on 2026-09-07
// read "Sorry, this job was removed at 04:07 a.m. (UTC) on Thursday, Jan 08,
// 2026" and answered HTTP 200. The page says it plainly; nothing was looking.
//
// This is deliberately NARROW. These pages are full of unrelated copy — saved-
// job rails, cookie banners, employer marketing — so a phrase only counts when
// it is about THIS posting, and "expired", "removed" or "filled" on their own
// are not evidence of anything.

/**
 * Phrases that mean the posting itself is gone.
 *
 * Each is a whole clause, not a keyword, because the keywords appear
 * everywhere: "removed from your saved jobs", "your session has expired", "we
 * filled 30 positions last year" are all live pages. A test pins each of those
 * as a non-match.
 */
const MARKERS = [
  "this job was removed",
  "this job is no longer available",
  "this job posting is no longer available",
  "no longer accepting applications",
  "this position has been filled",
  "this posting has expired",
  "this job has expired",
] as const;

/**
 * The marker a page carries, or null.
 *
 * Returns WHICH phrase matched rather than a boolean, so the log line names the
 * evidence — a rule that closes roles should be able to say why, and a bad
 * marker is then findable in the logs rather than inferred from a count.
 */
export function deadPostingMarker(html: string): string | null {
  // Tags out and whitespace collapsed first: the phrase is regularly split
  // across markup ("Sorry, <b>this job was removed</b> at …"), and a raw
  // substring search over the source misses exactly those.
  const text = html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
  return MARKERS.find((m) => text.includes(m)) ?? null;
}
