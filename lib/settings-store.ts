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

/**
 * Where `markCriteriaChanged` (Task 6) stamps the last edit to a setting that
 * changes WHAT THE CRAWLER LOOKS FOR — titles, locations, locationRule.
 *
 * Deliberately NOT in SETTING_KEYS. It is a stamp the app writes, not a
 * user-editable setting: it is not a `Criteria` field, mergeSettings must
 * never see it, and a settings form must never offer it. It is a named
 * constant only so the writer and the reader below cannot drift apart on the
 * spelling — the same silent-no-op hazard the SETTING_KEYS comment describes.
 *
 * Scope is narrower than "any setting changed" on purpose: `searchCeiling` and
 * `compFloor` do not change what the crawler looks for, so stamping on them
 * would suppress stale-posting closure for ~2 crawl cycles per company after
 * a change that cannot have invalidated a single previous result.
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
 * Returns null until Task 6 lands the writer — which is the correct answer
 * for a database where nothing has stamped it yet, not a placeholder.
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

export async function writeSetting(
  key: SettingKey,
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

export async function deleteSetting(key: SettingKey): Promise<{ error?: string }> {
  const { error } = await rawQuery(`delete from app_settings where key = $1`, [key]);
  return { error: error?.message };
}
