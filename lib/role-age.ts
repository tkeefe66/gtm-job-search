/**
 * How long ago a role landed in the pipeline, for the Roles table.
 *
 * The source is `jobs.created_at` (a `timestamptz` with a `now()` default), not
 * the posting's own publish date — nothing in the app knows when a job was
 * posted, only when this app first saved it. The label says "Found" for that
 * reason: it is the age of OUR record.
 *
 * Returns null for a missing/unparseable stamp so the caller can render nothing
 * rather than "Found NaNd ago". Rows written before the column existed, or by a
 * path that somehow skipped the default, simply show no age.
 */
export interface RoleAge {
  /**
   * The calendar date, e.g. "Aug 3". The year is appended ("Dec 4, 2025") ONLY
   * when it differs from `now`'s — on a list that is mostly weeks old, a
   * repeated ", 2026" is noise, but an undated December row is genuinely
   * ambiguous.
   */
  date: string;
  /** Compact age to sit beside the date in a row, e.g. "today", "3d", "2mo". */
  age: string;
  /** Prose relative label for detail views, e.g. "yesterday", "3d ago". */
  label: string;
  /** The date with its year always present, e.g. "Aug 3, 2026". */
  full: string;
  /** Tooltip text: the unambiguous full date, e.g. "Found Aug 3, 2026". */
  title: string;
  /** Whole days between the stamp and `now`, floored at 0. */
  days: number;
}

const DAY_MS = 86_400_000;

export function roleAge(createdAt: string | null | undefined, now: Date): RoleAge | null {
  if (!createdAt) return null;
  const found = new Date(createdAt);
  const ms = found.getTime();
  if (Number.isNaN(ms)) return null;

  // A stamp in the future (clock skew) reads as "today", never "-2d ago".
  const days = Math.max(0, Math.floor((now.getTime() - ms) / DAY_MS));
  const sameYear = found.getFullYear() === now.getFullYear();
  const full = fullDate(found);

  return {
    date: sameYear ? monthDay(found) : full,
    age: compactAge(days),
    label: proseAge(days),
    full,
    title: `Found ${full}`,
    days,
  };
}

function compactAge(days: number): string {
  if (days === 0) return "today";
  if (days < 14) return `${days}d`;
  if (days < 60) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

function proseAge(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${compactAge(days)} ago`;
}

function monthDay(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function fullDate(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
