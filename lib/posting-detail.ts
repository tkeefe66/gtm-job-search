// What a posting itself says, stored in the jobs table's `posting` jsonb.
//
// Kept out of the columns for one reason: these are the posting's own words,
// read for the DECIDE ("am I disqualified") and PREP (feed the résumé) jobs,
// and neither is a scoring input or a filter. A jsonb column also means the
// next field this needs is not a migration.

export interface PostingDetail {
  /** What the posting says it requires, in the posting's own words. */
  requirements: string[];
  /**
   * Stated preferences. Separate from requirements on purpose: the decide
   * question is "am I disqualified", and these do not disqualify.
   */
  niceToHaves: string[];
  /**
   * When the backfill last wrote this row, ISO-8601. Absent on a row ingest
   * wrote, which is the point: the enrich rescore offer compares this against
   * the `enrich_rescored_at` stamp, and an ingested row already scored on
   * these words needs no re-score.
   */
  enrichedAt?: string;
}

/**
 * The shape a row carries when the model gave nothing usable.
 *
 * Exported for tests and for the readers that need something to render; it is
 * never returned by reference — see postingDetailFrom.
 */
export const EMPTY_POSTING_DETAIL: PostingDetail = {
  requirements: [],
  niceToHaves: [],
};

/** A model's answer for one list, repaired into a list of real strings. */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/**
 * Builds the stored detail from whatever the extraction returned.
 *
 * REPAIRS rather than rejects, the contract resolveProfile and resolveStatuses
 * already establish: nothing normalizes a model's role array — every path casts
 * `parsed as Role[]` — so a model that answers with prose where a list was
 * asked for must yield an empty list here, not `undefined` in the jsonb.
 *
 * The returned object is always fresh. Handing back EMPTY_POSTING_DETAIL would
 * let one caller's push corrupt it for the life of the process.
 */
export function postingDetailFrom(role: {
  requirements?: unknown;
  nice_to_haves?: unknown;
}): PostingDetail {
  return {
    requirements: stringList(role.requirements),
    niceToHaves: stringList(role.nice_to_haves),
  };
}

/**
 * The newest moment the backfill wrote any of these rows, or null.
 *
 * One half of the enrichment rescore offer's gate; the other is the
 * `enrich_rescored_at` setting. Derived from rows the caller already holds
 * rather than from SQL, so the comparison the offer makes is expressible in a
 * test — the same reason EXPIRED_PREDICATE has a JS twin.
 *
 * A row with no `enrichedAt` is a row ingest wrote, not a row the backfill
 * touched, and is no evidence either way. An unparseable stamp is ignored
 * rather than compared as a string, where "whenever" would sort above every
 * real ISO timestamp and pin the offer on forever.
 */
export function latestEnrichedAt(
  jobs: { posting?: PostingDetail | null }[]
): string | null {
  return newestStamp(jobs.map((job) => job.posting?.enrichedAt));
}

/**
 * The newest parseable ISO timestamp in a list, or null.
 *
 * Separate from latestEnrichedAt because the settings page takes its value
 * from SQL (`max(posting->>'enrichedAt')`) rather than from rows, and that
 * answer still has to pass the same validity rule — a `max()` over text sorts
 * "whenever" above every real timestamp.
 */
export function newestStamp(stamps: (string | null | undefined)[]): string | null {
  let newest: string | null = null;
  let newestMs = -Infinity;
  for (const at of stamps) {
    if (typeof at !== "string") continue;
    const ms = Date.parse(at);
    if (!Number.isFinite(ms) || ms <= newestMs) continue;
    newest = at;
    newestMs = ms;
  }
  return newest;
}
