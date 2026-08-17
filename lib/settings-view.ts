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
  UNDESCRIBED_DB_ERROR,
  ceilingFrom,
  compFloorFrom,
  compScoringRescoredFrom,
  jobStatusesFrom,
  mergeSettings,
  profileFrom,
  type SettingRow,
} from "@/lib/settings-store";
import type { JobStatusDef } from "@/lib/job-statuses";
import type { Profile } from "@/lib/profile";

export interface SettingsView {
  criteria: Criteria;
  ceiling: number | null;
  /** The minimum base compensation, or null for "off". Filters /roles and feeds
   *  fit scoring — see Tasks 3 and 4 of the compensation-floor plan. */
  compFloor: number | null;
  scoredJobCount: number;
  fitBrainOverridden: boolean;
  /**
   * When a compensation rescore pass last completed, or null if never — the
   * SERVER half of the day-one rescore offer's gate. Without it the offer would
   * either never fire (a session-only rule cannot survive the page load it has
   * to fire on) or never stop (scoredJobCount is unchanged by a pass). See
   * compRescoreOffer in lib/rescore-progress.ts.
   */
  compScoringRescoredAt: string | null;
  /** The user's pipeline statuses, resolved from the same snapshot as the rest. */
  statuses: JobStatusDef[];
  /**
   * The tenant's career profile — the generated fields /settings' "How your
   * roles are scored" and "How your field is described" sections edit. Read
   * off the SAME snapshot as everything else above (see `profileFrom`'s own
   * doc): a second query here would be a second snapshot a concurrent save
   * could split the page across.
   */
  profile: Profile;
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
    // `|| UNDESCRIBED_DB_ERROR`: an empty message would render a dangling
    // "settings — ." and tell the user nothing about why.
    `Could not read your saved settings — ${error || UNDESCRIBED_DB_ERROR}. ` +
    `Everything below is the ` +
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
  // Presence, not truthiness — see UNDESCRIBED_DB_ERROR in lib/settings-store.
  // A pg failure with no DATABASE_URL carries an EMPTY message, and `error ? …`
  // drops the banner entirely: the page then renders the shipped defaults as
  // the user's saved values, which is precisely the state this warning exists
  // to prevent them from saving over.
  const problems = [
    input.settingsError !== undefined
      ? settingsReadWarning(input.settingsError)
      : undefined,
    // `countError` needs no such guard: its only producer (countScoredJobs in
    // app/actions/settings.ts) substitutes UNDESCRIBED_DB_ERROR at the source,
    // so a present countError is always non-empty.
    input.countError,
    // `p !== undefined` rather than `!!p`. Both elements above are guaranteed
    // non-empty-or-undefined today, so this predicate is defensive, not
    // load-bearing — it is spelled this way so that if either producer ever
    // stops normalizing, a failure is still reported instead of quietly
    // filtered out.
  ].filter((p): p is string => p !== undefined);

  return {
    criteria: mergeSettings(DEFAULT_CRITERIA, input.rows),
    ceiling: ceilingFrom(input.rows),
    compFloor: compFloorFrom(input.rows),
    scoredJobCount: input.scoredJobCount,
    // Gates the rescore prompt across page loads — a client component has no
    // memory, so "re-show it this session" would bury it on a fresh load.
    fitBrainOverridden: input.rows.some((r) => r.key === SETTING_KEYS.fitBrain),
    // Read off the SAME snapshot as everything else above rather than by a
    // query of its own — see compScoringRescoredFrom. On a failed settings
    // read `rows` is empty, so this reads as "never rescored" and the offer
    // shows; that is the safe direction (a redundant offer costs a dismissal,
    // a wrongly suppressed one loses the feature), and the read-failure banner
    // is already on screen next to it.
    compScoringRescoredAt: compScoringRescoredFrom(input.rows),
    statuses: jobStatusesFrom(input.rows),
    // Off the SAME snapshot as everything else in this function, for the
    // reason every other reader here gives: a second query is a second
    // snapshot a concurrent save could split the page across. On a failed
    // settings read `rows` is empty, so this reads as DEFAULT_PROFILE — the
    // same safe degradation `criteria` gets above, next to the same banner.
    profile: profileFrom(input.rows),
    // Joined rather than first-wins: the settings read and the count are
    // separate queries that fail separately, and hiding one behind the other
    // loses a failure the user needs.
    error: problems.length > 0 ? problems.join(" · ") : undefined,
  };
}
