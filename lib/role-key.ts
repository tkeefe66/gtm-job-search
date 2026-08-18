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

// ---------------------------------------------------------------------------
// Company IDENTITY, which is a different question from company NORMALIZATION.
//
// normalizeCompanyName (above) answers "is this the same string, modulo case
// and whitespace" and has a SQL twin it must stay byte-compatible with. This
// answers the looser question Discover actually asks when it decides whether
// two result rows are the same employer: probe A returned RTX as both
// "RTX (Raytheon)" and "Raytheon (RTX)", which are the same company written
// two ways and which normalizeCompanyName correctly reports as two different
// keys.
//
// DELIBERATELY SEPARATE, and deliberately NOT used for dedupe against `jobs`.
// Widening normalizeCompanyName to do this would silently widen the ingest
// dedupe lookup too, and that lookup is half of a pair whose other half is
// NORMALIZED_COMPANY_SQL — a Postgres expression that cannot express token
// sorting. The two would drift, the lookup would load zero rows, and the jobs
// table would refill with duplicate "New" rows. This key is for DISPLAY
// grouping only.
//
// The rule: lowercase and collapse (via normalizeCompanyName), split into
// word tokens, drop legal-form suffixes, drop duplicates, sort. Two names
// merge exactly when they are built from the same set of meaningful words.
//
// What that accepts, stated so the next reader does not have to derive it:
// two genuinely different employers whose names are anagrams at the word
// level ("Acme Health" / "Health Acme") would merge. That is the price of
// order-independence, which is what the RTX case requires — no ordering rule
// can tell "RTX (Raytheon)" from "Raytheon (RTX)" and still call them equal.
// ASCII punctuation and whitespace, plus the typographic marks that actually
// turn up in scraped company names: the dash range U+2010-2015, curly quotes,
// and the ellipsis. Everything NOT listed here — accented letters, non-Latin
// scripts, digits — is part of a token.
const NAME_SEPARATORS =
  /[\s!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~\u2010-\u2015\u2018\u2019\u201C\u201D\u2026]+/;

const LEGAL_FORM_TOKENS = new Set([
  "inc", "incorporated", "llc", "ltd", "limited", "corp", "corporation",
  "co", "plc", "gmbh", "ag", "nv", "bv", "sa", "spa", "pty", "srl",
]);

export function companyIdentityKey(company: string): string {
  // Split on SEPARATORS (whitespace and punctuation) rather than on "not a
  // letter or digit". The obvious spelling of the latter needs \p{L}/\p{N} and
  // the /u flag, which this repo's tsconfig cannot compile — it declares no
  // `target`, so the build's typecheck runs at ES5 and rejects the flag. The
  // ASCII fallback [^a-z0-9] is NOT an option: it truncates "Nestlé" to
  // "nestl", silently mangling every non-English name. Naming the separators
  // instead leaves every accented letter intact at any target.
  const tokens = normalizeCompanyName(company)
    .split(NAME_SEPARATORS)
    .filter(Boolean);

  // A company whose name is ENTIRELY legal-form words ("Ltd") must keep them
  // — stripping to nothing would collapse every such name onto one key.
  const meaningful = tokens.filter((t) => !LEGAL_FORM_TOKENS.has(t));
  const kept = meaningful.length > 0 ? meaningful : tokens;

  // Punctuation-only input yields no tokens at all. Fall back to the plain
  // normalized string rather than "", which would merge every such row.
  if (kept.length === 0) return normalizeCompanyName(company);

  return Array.from(new Set(kept)).sort().join(" ");
}
