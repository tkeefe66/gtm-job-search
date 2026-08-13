import { normalizeCompanyName } from "./role-key";

// Finds a row whose company name matches `name` under normalizeCompanyName —
// i.e. in TypeScript, against an already-fetched row set, not via a SQL
// `lower()` WHERE clause.
//
// This replaces a SQL-side `lower(company) = lower($1)` lookup that task 5's
// review found reintroduced the exact bug the task existed to close, just
// reached through whitespace instead of casing: SQL `lower()` does not
// collapse internal whitespace (or reliably fold U+00A0 the way JS's `\s`
// does), so a row stored as "Big  Co" (double space) would not match a
// lookup for "Big Co" — the write that followed then filtered with
// `.eq("company", ...)` on the untouched trimmed input, matched zero rows,
// and silently no-opped.
//
// Postgres's own whitespace/locale handling for `lower()` and `\s` is not
// verifiable without a database, so rather than try to replicate
// normalizeCompanyName in SQL, the match runs here — in TS, against the
// full row set, using the one normalizer every other company-identity
// comparison in this codebase already uses. The watchlist is a single
// user's list of tens of rows, so reading it in full is cheap. Do not
// "optimize" this back into a `lower()` query.
export function findExistingCompany<T extends { company: string }>(
  rows: T[],
  name: string
): T | undefined {
  const key = normalizeCompanyName(name);
  return rows.find((row) => normalizeCompanyName(row.company) === key);
}
