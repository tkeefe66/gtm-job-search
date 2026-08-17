// The pure half of user-editable job statuses.
//
// NO import of lib/supabase.ts, directly or transitively — this module is
// imported by "use client" components, and supabase pulls in `pg`. The read of
// the app_settings row lives in lib/settings-store.ts, which already imports it.
// Same hazard documented at components/Settings.tsx and lib/bulk-status.ts.
//
// NO Tailwind class strings either. tailwind.config.ts scans ./app/** and
// ./components/** only, so an arbitrary-value class written here would never be
// generated and the badge would render unstyled through a green build. The
// STATUS_STYLES map stays in components/RolesTable.tsx. Pinned by a test.

export type StatusBucket = "active" | "terminal";

/**
 * The statuses that code writes or reads BY NAME, not merely displays.
 *
 * They are why `jobs.status` stores keys rather than labels. Two of these are
 * matched in raw SQL that no settings page can reach —
 * `STALE_POSTING_CANDIDATES_SQL` (lib/crawler.ts) and `CRAWL_TITLE_MATCH_SQL`
 * (lib/removed-titles.ts) both say `status = 'New'` — and `db/schema.sql` makes
 * `'New'` the column default. A rename that rewrote rows would leave all three
 * matching nothing, silently disabling stale-posting closure.
 */
export type SystemStatusKey = "New" | "Applied" | "Posting Closed";

export const SYSTEM_STATUS_KEYS: SystemStatusKey[] = [
  "New",
  "Applied",
  "Posting Closed",
];

export interface JobStatusDef {
  /** Immutable. What jobs.status stores. */
  key: string;
  /** Displayed. Freely editable. */
  label: string;
  bucket: StatusBucket;
  hidden: boolean;
  /** Present iff this is a system status. */
  system?: SystemStatusKey;
}

/**
 * The shipped config, which must be a NO-OP against the pre-feature app.
 *
 * `active` is everything the old `"Open"` filter showed and link-health checked
 * — the seven in ACTIVE_STATUSES plus New and Offer, which were in neither
 * array. `terminal` is the four in TERMINAL_STATUSES. A test pins this against
 * lib/types.ts rather than trusting this comment.
 */
export const DEFAULT_STATUSES: JobStatusDef[] = [
  { key: "New", label: "New", bucket: "active", hidden: false, system: "New" },
  { key: "Applied", label: "Applied", bucket: "active", hidden: false, system: "Applied" },
  { key: "Recruiter Outreach", label: "Recruiter Outreach", bucket: "active", hidden: false },
  { key: "Phone / Intro Screen", label: "Phone / Intro Screen", bucket: "active", hidden: false },
  { key: "Hiring Manager", label: "Hiring Manager", bucket: "active", hidden: false },
  { key: "Panel Interviews", label: "Panel Interviews", bucket: "active", hidden: false },
  { key: "Exec Presentation", label: "Exec Presentation", bucket: "active", hidden: false },
  { key: "Reference Check", label: "Reference Check", bucket: "active", hidden: false },
  { key: "Offer", label: "Offer", bucket: "active", hidden: false },
  { key: "Not Interested", label: "Not Interested", bucket: "terminal", hidden: false },
  { key: "Rejected", label: "Rejected", bucket: "terminal", hidden: false },
  { key: "Passed", label: "Passed", bucket: "terminal", hidden: false },
  {
    key: "Posting Closed",
    label: "Posting Closed",
    bucket: "terminal",
    hidden: false,
    system: "Posting Closed",
  },
];

/** The bucket a system key is pinned to, or null if it may be either. */
const SYSTEM_BUCKET: Record<SystemStatusKey, StatusBucket | null> = {
  New: "active",
  Applied: null,
  "Posting Closed": "terminal",
};

const isBucket = (v: unknown): v is StatusBucket => v === "active" || v === "terminal";

/**
 * Turns whatever is in the jsonb row into a config the app can run on.
 *
 * REPAIRS rather than rejects, because rejecting means falling back to the
 * defaults wholesale — which silently un-hides statuses and reverts renames the
 * user made. A repaired config is used, never written back: the write happens
 * only when the user saves.
 *
 * CRITICAL: returns a copy of DEFAULT_STATUSES, never the reference itself.
 * Callers can mutate the result without corrupting the module-level fallback
 * for the life of the process. See mergeSettings in lib/settings-store.ts for
 * the same pattern and why it matters.
 */
export function resolveStatuses(raw: unknown): JobStatusDef[] {
  if (!Array.isArray(raw)) {
    // Return a fresh copy of the defaults, not the reference itself
    return DEFAULT_STATUSES.map((d) => ({ ...d }));
  }

  const byKey = new Map<string, JobStatusDef>();
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const key = typeof e.key === "string" ? e.key.trim() : "";
    if (!key) continue;
    if (byKey.has(key)) continue; // first wins

    const system = SYSTEM_STATUS_KEYS.find((k) => k === key);
    const label = typeof e.label === "string" && e.label.trim() ? e.label.trim() : key;
    const pinned = system ? SYSTEM_BUCKET[system] : null;
    const bucket = pinned ?? (isBucket(e.bucket) ? e.bucket : "active");

    byKey.set(key, {
      key,
      label,
      bucket,
      // A system status can never be hidden: db/schema.sql defaults the column
      // to "New" and two form defaults seed it in state, so hiding it would let
      // a form save a status the user never picked.
      hidden: system ? false : e.hidden === true,
      ...(system ? { system } : {}),
    });
  }

  if (byKey.size === 0) {
    // Return a fresh copy of the defaults, not the reference itself
    return DEFAULT_STATUSES.map((d) => ({ ...d }));
  }

  // Any system key the saved config dropped comes back, in its shipped position
  // relative to the others rather than appended blindly.
  for (const def of DEFAULT_STATUSES) {
    if (def.system && !byKey.has(def.key)) {
      // Make a copy of the default entry to avoid sharing the reference
      byKey.set(def.key, { ...def });
    }
  }

  return Array.from(byKey.values());
}

/** A key for a new status, derived from its label and unique against `taken`. */
export function slugify(label: string, taken: Iterable<string>): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "status";
  const used = new Set(taken);
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/**
 * What to DISPLAY for a stored status value.
 *
 * An unrecognised key returns itself rather than a placeholder: it means a
 * hand-edited or legacy row, and showing the user what the database actually
 * holds is more useful than "Unknown".
 */
export function labelFor(defs: JobStatusDef[], key: string): string {
  return defs.find((d) => d.key === key)?.label ?? key;
}

/**
 * Which tile a stored status counts in.
 *
 * An unrecognised key is `active`, deliberately. The default "Open" filter hides
 * terminal rows, so bucketing it the other way would make a row that plainly
 * exists in the database vanish from the table with nothing to explain it.
 */
export function bucketFor(defs: JobStatusDef[], key: string): StatusBucket {
  return defs.find((d) => d.key === key)?.bucket ?? "active";
}

export function terminalKeys(defs: JobStatusDef[]): string[] {
  return defs.filter((d) => d.bucket === "terminal").map((d) => d.key);
}

/**
 * The options a <select> must render, given what the row currently holds.
 *
 * `current` is ALWAYS included, even when hidden or absent from the config. A
 * `<select value={v}>` whose value matches no `<option>` renders the FIRST
 * option instead — so without this, hiding a status would make every row
 * holding it display something else while the database disagreed.
 */
export function optionsFor(defs: JobStatusDef[], current: string): JobStatusDef[] {
  const visible = defs.filter((d) => !d.hidden || d.key === current);
  if (visible.some((d) => d.key === current)) return visible;
  return [...visible, { key: current, label: current, bucket: "active", hidden: false }];
}

/**
 * The two tile counts. Every stored value lands in exactly one of them, for any
 * config and any value — that is what makes the sum invariant true by
 * construction rather than by test.
 */
export function tileCounts(
  defs: JobStatusDef[],
  stored: string[]
): { open: number; out: number } {
  let open = 0;
  let out = 0;
  for (const s of stored) {
    if (bucketFor(defs, s) === "terminal") out++;
    else open++;
  }
  return { open, out };
}

/** Sorts stored status values into config order. Unknown keys sort last. */
export function compareByConfig(defs: JobStatusDef[]): (a: string, b: string) => number {
  const index = new Map(defs.map((d, i) => [d.key, i]));
  const rank = (k: string) => index.get(k) ?? Number.MAX_SAFE_INTEGER;
  return (a, b) => rank(a) - rank(b);
}
