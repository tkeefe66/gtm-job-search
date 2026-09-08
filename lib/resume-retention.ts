//
// The single home of the 60-day window AND of both SQL comparisons.
//
// The predicates are exported as strings, not retyped at each call site, for a
// specific reason: the purge and the two read paths express their comparison in
// SQL, which no vitest test can execute. With `<=` and `>` sitting in three
// separate SQL literals, changing one is invisible to the whole suite. Exported,
// they become values a test can assert are complementary — see
// resume-retention.test.ts. CLAUDE.md records the compFloor `>`-not-`>=` rule as
// a live two-places hazard; this is the same hazard, closed.

export const RETENTION_DAYS = 60;

/** The newest checkpoint for a job. Shorter than a deliberate Save because the
 *  user did not choose to keep it — the app wrote it to protect their work. */
export const CHECKPOINT_RETENTION_DAYS = 30;

/** A checkpoint that a newer one has superseded. A checkpoint's real job is
 *  "undo what I just did", which is a same-session need. */
export const SUPERSEDED_CHECKPOINT_DAYS = 3;

const COLUMN = "expires_at";
const EXPIRED_OP = "<=";
const LIVE_OP = ">";

/** Rows the purge collects. A row expiring exactly now IS expired. */
export const EXPIRED_PREDICATE = COLUMN + " " + EXPIRED_OP + " now()";

/** Rows reads may show. Exact complement of EXPIRED_PREDICATE. */
export const LIVE_PREDICATE = COLUMN + " " + LIVE_OP + " now()";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function expiresAtFrom(now: Date, days: number = RETENTION_DAYS): Date {
  return new Date(now.getTime() + days * MS_PER_DAY);
}

/** The JS twin of EXPIRED_PREDICATE. Must agree with it — a test asserts so. */
export function isExpired(expiresAt: Date, now: Date): boolean {
  return expiresAt.getTime() <= now.getTime();
}
