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
  /** Short relative label, e.g. "today", "3d ago", "2mo ago". */
  label: string;
  /** Absolute date on its own, e.g. "Aug 3, 2026". */
  date: string;
  /** Absolute date for the tooltip, e.g. "Found Aug 3, 2026". */
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

  const date = absoluteDate(found);
  return { label: ageLabel(days), date, title: `Found ${date}`, days };
}

function ageLabel(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days}d ago`;
  if (days < 60) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

function absoluteDate(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
