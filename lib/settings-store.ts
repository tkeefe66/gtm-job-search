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

/** Reads one scalar setting. A missing row, or a row holding a non-number
 *  (a bad write, a hand-edit), reads as null — the same as "not set". */
export async function readNumberSetting(key: SettingKey): Promise<number | null> {
  const rows = await readAllSettings();
  const row = rows.find((r) => r.key === key);
  return typeof row?.value === "number" ? row.value : null;
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
 * When any setting was last written, as an ISO string, or null when nothing
 * has ever been saved (a fresh install running purely on shipped defaults).
 *
 * Read separately from readAllSettings rather than widening SettingRow: the
 * merge path has no use for per-row timestamps, and widening the row type
 * would ripple into mergeSettings' shape guard.
 *
 * Fails soft to null for the same reason readAllSettings does — this is
 * decoration on a crawl run, and a failed read must not abort one.
 */
export async function readCriteriaChangedAt(): Promise<string | null> {
  const { data, error } = await rawQuery<{ changed_at: string | Date | null }>(
    `select max(updated_at) as changed_at from app_settings`
  );
  if (error) {
    console.error(
      `settings-store: could not read the settings timestamp — ${error.message}.`
    );
    return null;
  }
  const raw = data?.[0]?.changed_at ?? null;
  // pg returns timestamptz as a Date; normalize so callers always see ISO.
  if (raw instanceof Date) return raw.toISOString();
  return raw;
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
