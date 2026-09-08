// Rows that are not roles: a job board's SEARCH page stored as a posting, and a
// company name that describes an employer instead of naming one.
//
// Found in production 2026-09-07 — 15 of them, scored 2 to 4 and sitting in the
// open pipeline looking like work. `indeed.com/q-…-jobs.html` is a query, not a
// posting; `Confidential (via CSG Talent)` is a recruiter's discretion, not an
// employer. Nothing downstream can read, verify, or apply to either, and no
// amount of sourcing improvement reaches them, because there is no posting.
//
// Both checks are deliberately narrow. The cost of a false positive here is
// closing a real role, so a real posting on the same hosts, and a real employer
// whose name merely contains one of these words, must both survive.

export type NotAPostingReason = "search-page" | "no-employer";

/**
 * Search/category pages, matched on the SHAPE these hosts use for them.
 *
 * Not a host check: Indeed, ZipRecruiter and Glassdoor all serve real postings
 * too, and this codebase already carries the aggregator-versus-employer
 * distinction elsewhere. What is wrong with these URLs is that they name a
 * QUERY — a set of results that changes daily — rather than one posting.
 */
const SEARCH_SHAPES: RegExp[] = [
  // indeed.com/q-<terms>-jobs.html, and the l-<location> variants
  /indeed\.com\/(q-|l-|jobs\?)/i,
  // ziprecruiter.com/Jobs/<Category> — their postings carry /c/<company>/Job/ or a jid
  /ziprecruiter\.com\/Jobs\//i,
  // glassdoor's SRCH pages; their postings are /job-listing/ or /partner/jobListing
  /glassdoor\.[a-z.]+\/Job\/.*SRCH/i,
  // linkedin's search surface, as opposed to /jobs/view/<id>
  /linkedin\.com\/jobs\/search/i,
];

/**
 * Names that describe an employer rather than naming one.
 *
 * Anchored to the START and required to be the whole name or followed by a
 * qualifier in brackets or after a dash — "Confidential Computing Inc" and
 * "Stealth Health" are real companies, and a bare `includes` would close them.
 */
const PLACEHOLDER_NAMES = /^(confidential|undisclosed|stealth startup|company confidential)\b\s*(\(|-|—|$)/i;

/**
 * Why this row is not a role, or null when it is one.
 *
 * Called at ingest, so these never enter again, and by link health, so the ones
 * already stored can be cleared.
 */
export function notAPosting(
  url: string | null | undefined,
  company: string
): NotAPostingReason | null {
  if (PLACEHOLDER_NAMES.test(company.trim())) return "no-employer";
  if (!url) return null;
  return SEARCH_SHAPES.some((shape) => shape.test(url)) ? "search-page" : null;
}
