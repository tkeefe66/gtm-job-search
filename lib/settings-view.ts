// What the settings page is handed, assembled from one snapshot of
// app_settings plus the scored-role count.
//
// Pure, and out here rather than inline in app/actions/settings.ts, for the
// usual reason in this repo: the action reads the database, so nothing inside
// it can be tested — and the decision this file makes is the one that decides
// whether a failed read is visible to the user or is silently rendered as
// their saved settings.

import { DEFAULT_CRITERIA, type Criteria } from "@/lib/search-criteria";
import {
  SETTING_KEYS,
  ceilingFrom,
  mergeSettings,
  type SettingRow,
} from "@/lib/settings-store";

export interface SettingsView {
  criteria: Criteria;
  ceiling: number | null;
  scoredJobCount: number;
  fitBrainOverridden: boolean;
  /** Everything wrong with this load, in one line, or absent when clean. */
  error?: string;
}

export interface SettingsViewInput {
  rows: SettingRow[];
  /** Why app_settings could not be read, if it could not. */
  settingsError: string | undefined;
  scoredJobCount: number;
  /** Why the scored-role count could not be taken, if it could not. */
  countError: string | undefined;
}

/**
 * What to tell the user when app_settings could not be read.
 *
 * Says the two things that matter and nothing else: what is on screen is NOT
 * theirs, and saving would replace what is stored with it. A failed read of
 * this one table is otherwise invisible — the criteria merge falls back to the
 * shipped defaults, `fitBrainOverridden` reads false, and (because the jobs
 * table is queried separately and is fine) the page renders as a completely
 * ordinary "no overrides yet" settings page.
 */
export function settingsReadWarning(error: string): string {
  return (
    `Could not read your saved settings — ${error}. Everything below is the ` +
    `shipped default, NOT what you have saved. Do not save from this page ` +
    `until it loads cleanly: saving would overwrite your stored values with ` +
    `the defaults shown here. Reload to try again.`
  );
}

/**
 * Assembles the page's state from rows already read.
 *
 * `settingsError` and `countError` are REQUIRED keys (as `string | undefined`)
 * rather than optional ones: dropping either at the call site is then a
 * compile error rather than a silent return to the swallowing behavior this
 * function exists to end.
 */
export function buildSettingsView(input: SettingsViewInput): SettingsView {
  const problems = [
    input.settingsError ? settingsReadWarning(input.settingsError) : undefined,
    input.countError,
  ].filter((p): p is string => !!p);

  return {
    criteria: mergeSettings(DEFAULT_CRITERIA, input.rows),
    ceiling: ceilingFrom(input.rows),
    scoredJobCount: input.scoredJobCount,
    // Gates the rescore prompt across page loads — a client component has no
    // memory, so "re-show it this session" would bury it on a fresh load.
    fitBrainOverridden: input.rows.some((r) => r.key === SETTING_KEYS.fitBrain),
    // Joined rather than first-wins: the settings read and the count are
    // separate queries that fail separately, and hiding one behind the other
    // loses a failure the user needs.
    error: problems.length > 0 ? problems.join(" · ") : undefined,
  };
}
