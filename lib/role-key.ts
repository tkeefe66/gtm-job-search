// Dedupe key for roles. Deliberately ignores job status: a role the user
// already marked Rejected or Not Interested must never be re-added as New by
// a later crawl.

export function normalizeTitle(title: string): string {
  // \s covers U+00A0 (non-breaking space), which scraped careers-page titles
  // are full of — collapsing it is load-bearing for dedupe, so it is tested.
  return title.replace(/\s+/g, " ").trim().toLowerCase();
}

export function normalizeRoleKey(company: string, roleTitle: string): string {
  return `${normalizeTitle(company)}::${normalizeTitle(roleTitle)}`;
}

// Company identity (watchlist dedupe, Discover's "already watched?" checks)
// needs exactly the same normalization as role titles: lowercase, trim,
// collapse whitespace including U+00A0. Aliased rather than reimplemented —
// see the module comment in app/actions/watchlist.ts for why a second,
// subtly different normalizer is the failure mode this is meant to prevent.
export const normalizeCompanyName = normalizeTitle;

// SQL twin of normalizeCompanyName, for the ONE query that cannot do the
// comparison in TypeScript: lib/ingest-roles.ts's dedupe lookup, which reads
// from `jobs`. app/actions/watchlist.ts solved the same problem by reading
// every row and matching in TS, but that is only acceptable because the
// watchlist is a single user's list of tens of rows; `jobs` is unbounded, so
// the WHERE clause has to do the narrowing.
//
// THESE TWO NORMALIZERS MUST STAY IN SYNC. normalizeCompanyName (above) and
// NORMALIZED_COMPANY_SQL (here) are compared against each other on every
// crawl: ingest-roles passes normalizeCompanyName(company) as the parameter
// and lets Postgres apply this expression to the stored column. If they
// disagree, the lookup loads zero rows, every role looks new, and the jobs
// table fills with duplicate "New" rows — the exact bug the tracking build
// closed. Change one, change the other, and update lib/role-key.test.ts.
//
// Piece by piece, matching `title.replace(/\s+/g, " ").trim().toLowerCase()`:
//   lower(company)                  -> .toLowerCase()
//   replace(..., chr(160), ' ')     -> JS \s matches U+00A0; Postgres's own
//                                      whitespace classes may not, and whether
//                                      they do is locale/collation dependent.
//                                      chr(160) names the character outright
//                                      so nothing is left to the server's
//                                      locale. (chr() is used rather than a
//                                      U&'\00A0' literal so the expression
//                                      does not depend on
//                                      standard_conforming_strings either.)
//   regexp_replace(..., '[[:space:]]+', ' ', 'g')
//                                   -> .replace(/\s+/g, " "). The POSIX class
//                                      is spelled out rather than '\s' because
//                                      a TypeScript string literal silently
//                                      eats the backslash in "\s", which would
//                                      leave the SQL collapsing the letter "s".
//   btrim(...)                      -> .trim(). Safe as the outer call: by
//                                      this point every whitespace run is a
//                                      single ASCII space, which is exactly
//                                      what btrim's default strips.
export const NORMALIZED_COMPANY_SQL =
  "btrim(regexp_replace(replace(lower(company), chr(160), ' '), '[[:space:]]+', ' ', 'g'))";
