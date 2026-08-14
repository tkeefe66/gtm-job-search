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
 */
export function mergeSettings<T extends Record<string, unknown>>(
  defaults: T,
  rows: SettingRow[]
): T {
  const merged = { ...defaults };
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
    (merged as Record<string, unknown>)[row.key] = row.value;
  }
  return merged;
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

/** Reads one scalar setting, taking its own snapshot of app_settings. */
export async function readNumberSetting(key: SettingKey): Promise<number | null> {
  return numberFrom(await readAllSettings(), key);
}

export const readCeiling = () => readNumberSetting(SETTING_KEYS.searchCeiling);

export async function readAllSettings(): Promise<SettingRow[]> {
  const { data, error } = await rawQuery<{ key: string; value: unknown }>(
    `select key, value from app_settings`
  );
  if (error) {
    // Deliberately not thrown: the crawler calls this on every run, and an
    // empty title list would make it silently report "no roles" for every
    // tracked company. Falling back to shipped defaults keeps last-known-good
    // behavior. Loud in the log, invisible in behavior.
    console.error(
      `settings-store: could not read app_settings — ${error.message}. ` +
        `Falling back to shipped defaults.`
    );
    return [];
  }
  return data ?? [];
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
    console.error(
      `settings-store: could not read "${CRITERIA_CHANGED_AT_KEY}" — ${error.message}.`
    );
    return null;
  }
  return data?.[0]?.value ?? null;
}

// One upsert for every writer in this file. The key type is widened by exactly
// one literal — the stamp, which is deliberately not a SettingKey — rather
// than to `string`, so a typo still cannot reach app_settings even through
// this private helper.
async function upsertSetting(
  key: SettingKey | typeof CRITERIA_CHANGED_AT_KEY,
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

export async function deleteSetting(key: SettingKey): Promise<{ error?: string }> {
  const { error } = await rawQuery(`delete from app_settings where key = $1`, [key]);
  return { error: error?.message };
}
