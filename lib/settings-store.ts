import { rawQuery } from "@/lib/supabase";

// The full set of editable settings. Adding one here plus a default in
// lib/search-criteria.ts is the whole change — app_settings is key/value, so
// there is no migration.
// Values MUST equal the `Criteria` field names in lib/search-criteria.ts —
// mergeSettings skips unknown keys BY DESIGN, so a drifted spelling makes
// every save a silent no-op with no error anywhere. Pinned by a test.
export const SETTING_KEYS = {
  titles: "titles",
  locations: "locations",
  stackTerms: "stackTerms",
  locationRule: "locationRule",
  fitBrain: "fitBrain",
  searchCeiling: "searchCeiling",
  compFloor: "compFloor",
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

// Settings partitioned by the SHAPE of their stored value. Without this,
// `saveCriteriaText(SETTING_KEYS.titles, …)` type-checks, writes a bare string
// under "titles", and mergeSettings' shape guard then ignores that row forever
// while the save reports success — the silent-no-op failure this file's other
// comments keep warning about, reached through a different door.
//
// Runtime arrays rather than hand-written unions so the partition can also be
// asserted exhaustive by a test, not only by tsc.
export const LIST_SETTING_KEYS = [
  SETTING_KEYS.titles,
  SETTING_KEYS.locations,
  SETTING_KEYS.stackTerms,
] as const;
export const TEXT_SETTING_KEYS = [
  SETTING_KEYS.locationRule,
  SETTING_KEYS.fitBrain,
] as const;
export const NUMBER_SETTING_KEYS = [
  SETTING_KEYS.searchCeiling,
  SETTING_KEYS.compFloor,
] as const;

export type ListSettingKey = (typeof LIST_SETTING_KEYS)[number];
export type TextSettingKey = (typeof TEXT_SETTING_KEYS)[number];
export type NumberSettingKey = (typeof NUMBER_SETTING_KEYS)[number];

/**
 * Compile-time exhaustiveness. A new SETTING_KEYS entry that joins none of the
 * three groups above makes `Exclude<…>` a non-`never` literal union, which
 * violates `T extends never` and fails the build here — so a new setting
 * cannot reach a save action with no shape declared.
 */
type AssertNever<T extends never> = T;
export type SettingKeysAreFullyClassified = AssertNever<
  Exclude<SettingKey, ListSettingKey | TextSettingKey | NumberSettingKey>
>;

/**
 * Where `writeCriteriaChangedAt` (below) stamps the last edit to a setting that
 * changes WHAT THE CRAWLER LOOKS FOR.
 *
 * Deliberately NOT in SETTING_KEYS. It is a stamp the app writes, not a
 * user-editable setting: it is not a `Criteria` field, mergeSettings must
 * never see it, and a settings form must never offer it. It is a named
 * constant only so the writer and the reader below cannot drift apart on the
 * spelling — the same silent-no-op hazard the SETTING_KEYS comment describes.
 *
 * Scope is narrower than "any setting changed" on purpose, and narrower still
 * than it once read here. `searchCeiling` and `compFloor` never reach the
 * crawler at all; `fitBrain` re-scores roles rather than changing which ones
 * are found; and `locations` is consumed ONLY by titleQueries/stackQueries in
 * lib/search-criteria.ts — the crawl path (lib/crawler.ts:76 and :299) reads
 * `titleListForPrompt` and `locationRule` and nothing else. Stamping on any of
 * them would suppress stale-posting closure for ~2 crawl cycles per company
 * after a change the crawler cannot observe.
 *
 * The live list is AFFECTS_CRAWL in lib/settings-effects.ts, where it is
 * pinned by tests.
 */
export const CRITERIA_CHANGED_AT_KEY = "criteria_changed_at";

/**
 * Where `writeCompScoringRescoredAt` (below) stamps the completion of a rescore
 * pass run because compensation joined fit scoring.
 *
 * A second stamp key, kept outside SETTING_KEYS for exactly the reasons
 * CRITERIA_CHANGED_AT_KEY is: it is written by the app, it is not a `Criteria`
 * field, mergeSettings must never see it, and no settings form may offer it.
 *
 * WHY a stamp is needed at all: shipping compensation into `scoreFit` made
 * every score already in `jobs` stale on DEPLOY, with no user edit anywhere to
 * hang the offer off. `scoredJobCount > 0` cannot be the whole trigger —
 * rescoring UPDATES scores rather than removing them, so that count is
 * unchanged by a successful pass and the offer would return immediately, and
 * forever. This row is what a completed pass leaves behind to say "asked and
 * answered". There is no version column by design (the no-migration constraint
 * ruled one out), so it records that a pass RAN, not which rows predate the
 * change — see compRescoreOffer in lib/rescore-progress.ts, and the prompt copy
 * it chooses, which is careful not to claim otherwise.
 */
export const COMP_SCORING_RESCORED_AT_KEY = "comp_scoring_rescored_at";

export interface SettingRow {
  key: string;
  value: unknown;
}

/**
 * Overlays stored rows onto the shipped defaults.
 *
 * A row whose key is not already present in `defaults` is ignored rather than
 * merged: an unknown key is either a leftover from a removed setting or a
 * typo, and letting it through would put a field on the criteria object that
 * nothing reads and no default documents. A stored null is treated the same
 * way as a missing row, so a bad write degrades to the default instead of
 * blanking a list the crawler depends on.
 *
 * Every array value is COPIED, never aliased. `{ ...defaults }` is shallow, so
 * an un-overridden `criteria.titles` would be DEFAULT_TARGET_TITLES itself —
 * the module constant, shared by every caller in the process. Nothing sorts or
 * pushes onto a criteria list today, but the day something does, it would
 * corrupt the fallback that the crawler and every search path degrade to, for
 * the lifetime of the process, with no stored row to explain it.
 */
export function mergeSettings<T extends Record<string, unknown>>(
  defaults: T,
  rows: SettingRow[]
): T {
  const merged: Record<string, unknown> = { ...defaults };
  for (const key of Object.keys(merged)) {
    const value = merged[key];
    if (Array.isArray(value)) merged[key] = [...value];
  }
  for (const row of rows) {
    if (!(row.key in defaults)) continue;
    if (row.value === null || row.value === undefined) continue;
    // Shape guard. Without it a row like {key:"titles", value:"a string"}
    // passes every check above and lands on criteria.titles, and
    // titleListForPrompt then calls .join on a string and throws mid-crawl.
    const before = defaults[row.key];
    if (Array.isArray(before) !== Array.isArray(row.value)) {
      console.error(
        `settings-store: ignoring "${row.key}" — stored value is the wrong shape.`
      );
      continue;
    }
    if (!Array.isArray(before) && typeof before !== typeof row.value) {
      console.error(
        `settings-store: ignoring "${row.key}" — expected ${typeof before}.`
      );
      continue;
    }
    // Copied for the same reason the defaults are, above: a stored array is
    // fresh per read today, but the merged object must not alias anything a
    // caller could later hold on to.
    merged[row.key] = Array.isArray(row.value) ? [...row.value] : row.value;
  }
  return merged as T;
}

/**
 * Picks one scalar setting out of rows ALREADY read. A missing row, or a row
 * holding a non-number (a bad write, a hand-edit), reads as null — the same as
 * "not set".
 *
 * Pure, and separate from readNumberSetting, so a caller that needs two values
 * can take one snapshot of app_settings and derive both from it. Two
 * sequential reads are not just two round trips: a save landing between them
 * splits the caller across two different versions of the settings.
 */
export function numberFrom(rows: SettingRow[], key: SettingKey): number | null {
  const row = rows.find((r) => r.key === key);
  return typeof row?.value === "number" ? row.value : null;
}

/** The search ceiling out of rows already read. See numberFrom. */
export const ceilingFrom = (rows: SettingRow[]) =>
  numberFrom(rows, SETTING_KEYS.searchCeiling);

/** The minimum base compensation out of rows already read. See numberFrom. */
export const compFloorFrom = (rows: SettingRow[]) =>
  numberFrom(rows, SETTING_KEYS.compFloor);

/**
 * When the compensation rescore pass last completed, out of rows ALREADY read,
 * or null when it never has.
 *
 * A pure row reader rather than a `readCriteriaChangedAt`-style query of its
 * own, and that is the whole point. The stamp's only consumer is the settings
 * page, which already takes ONE snapshot of app_settings (see getSettings) —
 * `select key, value from app_settings` returns this row along with everything
 * else, so a second query would buy nothing but a second snapshot a concurrent
 * save could split the page across. Being pure also makes the key-scoping
 * testable with no database at all, which is the motivation
 * CRITERIA_CHANGED_AT_SQL is exported for; this shape gets there without any
 * SQL to pin. The crawler's stamp keeps its own reader because the crawler has
 * no snapshot to read it out of.
 *
 * A row holding a non-string (a bad write, a hand-edit) reads as "never", not
 * as "stamped". That direction is deliberate: the failure it causes is the
 * offer appearing again, which one rescore clears, rather than the offer being
 * suppressed forever by a value nothing can interpret.
 */
export function compScoringRescoredFrom(rows: SettingRow[]): string | null {
  const row = rows.find((r) => r.key === COMP_SCORING_RESCORED_AT_KEY);
  return typeof row?.value === "string" ? row.value : null;
}

/** Reads one scalar setting, taking its own snapshot of app_settings. */
export async function readNumberSetting(key: SettingKey): Promise<number | null> {
  return numberFrom(await readAllSettings(), key);
}

export const readCeiling = () => readNumberSetting(SETTING_KEYS.searchCeiling);
export const readCompFloor = () => readNumberSetting(SETTING_KEYS.compFloor);

/**
 * The same read as `readAllSettings`, but WITH the failure channel.
 *
 * Two readers rather than one because the two callers need opposite things.
 * The crawler and every search path must degrade to shipped defaults and keep
 * running (see readAllSettings below) — that swallowing is deliberate and
 * load-bearing. The settings PAGE must not: with no error channel, a transient
 * failure on this one query renders the shipped defaults as if they were the
 * user's saved values, and the next Save overwrites their stored fit brain
 * with default-derived text. There is no history table to recover it from.
 */
/**
 * Stands in for a driver error that arrived with nothing to say.
 *
 * With DATABASE_URL unset, pg rejects with an Error whose `message` is the
 * EMPTY STRING. An empty string is falsy, so every `if (error)` downstream —
 * including the one in readAllSettings below, and the settings page's own
 * banner — reads a hard read failure as success with no rows. The whole
 * failure channel this function exists to provide silently evaporates, and a
 * build with no database produces a clean log and a permanently wrong page.
 *
 * The fix has two halves, and they live in different places on purpose.
 * DETECTION is presence: every reader branches on `error !== undefined`, never
 * on truthiness, so an undescribed failure is still a failure. DESCRIPTION is
 * this constant, substituted where the message is about to be shown or logged.
 * readAllSettingsResult keeps the driver's message verbatim — including the
 * empty one — because a transport layer that invents text makes the presence
 * check untestable, and the presence check is the half that actually matters.
 */
export const UNDESCRIBED_DB_ERROR =
  "the database driver failed without a message (typically an unset or unreachable DATABASE_URL)";

export async function readAllSettingsResult(): Promise<{
  rows: SettingRow[];
  error?: string;
}> {
  const { data, error } = await rawQuery<{ key: string; value: unknown }>(
    `select key, value from app_settings`
  );
  // The message is passed through verbatim, empty string included: the key
  // being PRESENT is the failure signal. See UNDESCRIBED_DB_ERROR.
  if (error) return { rows: [], error: error.message };
  return { rows: data ?? [] };
}

export async function readAllSettings(): Promise<SettingRow[]> {
  const { rows, error } = await readAllSettingsResult();
  // Presence, not truthiness — see UNDESCRIBED_DB_ERROR. `if (error)` here
  // made the "loud in the log" promise below conditional on the driver having
  // bothered to describe itself.
  if (error !== undefined) {
    // Deliberately not thrown: the crawler calls this on every run, and an
    // empty title list would make it silently report "no roles" for every
    // tracked company. Falling back to shipped defaults keeps last-known-good
    // behavior. Loud in the log, invisible in behavior.
    console.error(
      `settings-store: could not read app_settings — ` +
        `${error || UNDESCRIBED_DB_ERROR}. Falling back to shipped defaults.`
    );
    return [];
  }
  return rows;
}

/**
 * When the search criteria were last edited, as the ISO string
 * `markCriteriaChanged` stamped, or null when they never have been.
 *
 * Reads the single stamped row rather than `max(updated_at)` across the
 * table: the stamp's whole value is that it covers ONLY the settings that
 * change what the crawler looks for. See CRITERIA_CHANGED_AT_KEY.
 *
 * The writer is `writeCriteriaChangedAt` below; the decision of WHEN to call
 * it is AFFECTS_CRAWL in lib/settings-effects.ts. Null means no crawl-relevant
 * setting has ever been edited, which is the correct answer for a fresh
 * database rather than a placeholder.
 *
 * `#>> '{}'` extracts the jsonb scalar as plain text, so a stored JSON string
 * comes back without its quotes.
 *
 * The query is exported (rather than inlined) so the key-scoping decision can
 * be pinned by a string-content test without a database — same pattern, and
 * the same motivation, as LAST_TRUSTWORTHY_RUN_SQL in lib/crawler.ts.
 *
 * Fails soft to null for the same reason readAllSettings does — this is
 * decoration on a crawl run, and a failed read must not abort one.
 */
export const CRITERIA_CHANGED_AT_SQL = `select value #>> '{}' as value
      from app_settings
     where key = $1`;

export async function readCriteriaChangedAt(): Promise<string | null> {
  const { data, error } = await rawQuery<{ value: string | null }>(
    CRITERIA_CHANGED_AT_SQL,
    [CRITERIA_CHANGED_AT_KEY]
  );
  if (error) {
    // `error` is an object here, so the branch is already presence-based; only
    // the interpolated message needs the empty-string guard.
    console.error(
      `settings-store: could not read "${CRITERIA_CHANGED_AT_KEY}" — ` +
        `${error.message || UNDESCRIBED_DB_ERROR}.`
    );
    return null;
  }
  return data?.[0]?.value ?? null;
}

// One upsert for every writer in this file. The key type is widened by exactly
// the two stamp literals — neither of which is a SettingKey — rather than to
// `string`, so a typo still cannot reach app_settings even through this
// private helper. Add a literal per stamp; never `string`.
async function upsertSetting(
  key:
    | SettingKey
    | typeof CRITERIA_CHANGED_AT_KEY
    | typeof COMP_SCORING_RESCORED_AT_KEY,
  value: unknown
): Promise<{ error?: string }> {
  const { error } = await rawQuery(
    `insert into app_settings (key, value, updated_at)
     values ($1, $2::jsonb, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, JSON.stringify(value)]
  );
  return { error: error?.message };
}

export async function writeSetting(
  key: SettingKey,
  value: unknown
): Promise<{ error?: string }> {
  return upsertSetting(key, value);
}

/**
 * Stamps `criteria_changed_at` with now — the writer `readCriteriaChangedAt`
 * above has been waiting for.
 *
 * Lives here, next to the reader and the key, rather than in
 * app/actions/settings.ts: the doc on CRITERIA_CHANGED_AT_KEY says the
 * constant exists so writer and reader cannot drift on the spelling, and a
 * writer in another file that has to widen `SettingKey` to reach it would
 * reopen exactly that hazard. Callers decide WHETHER to stamp (see
 * lib/settings-effects.ts); this decides HOW.
 *
 * Stored as a JSON string so `#>> '{}'` reads it straight back out as text.
 */
export async function writeCriteriaChangedAt(
  when: Date = new Date()
): Promise<{ error?: string }> {
  return upsertSetting(CRITERIA_CHANGED_AT_KEY, when.toISOString());
}

/**
 * Stamps `comp_scoring_rescored_at` with now, which is what stops the
 * compensation rescore offer coming back on every page load.
 *
 * Lives here, next to the key and the reader, for the reason spelled out on
 * writeCriteriaChangedAt: a writer in another module would have to widen
 * `SettingKey` to reach the key, reopening the exact typo hazard the constant
 * exists to close. Callers decide WHEN to stamp — only after a pass that
 * actually finished, see handleRescore in components/Settings.tsx; a partial or
 * failed pass must leave the offer standing.
 *
 * Stored as a JSON string, matching the other stamp.
 */
export async function writeCompScoringRescoredAt(
  when: Date = new Date()
): Promise<{ error?: string }> {
  return upsertSetting(COMP_SCORING_RESCORED_AT_KEY, when.toISOString());
}

export async function deleteSetting(key: SettingKey): Promise<{ error?: string }> {
  const { error } = await rawQuery(`delete from app_settings where key = $1`, [key]);
  return { error: error?.message };
}
