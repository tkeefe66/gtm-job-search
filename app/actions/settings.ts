"use server";

import { updateJob } from "@/app/actions/jobs";
import { scoreFit } from "@/app/actions/parse-role";
import { validateList } from "@/lib/criteria-validation";
import { SCORED_JOBS_SQL } from "@/lib/rescore-scope";
import {
  DEFAULT_CRITERIA,
  loadScoringInputs,
  type Criteria,
} from "@/lib/search-criteria";
import { affectsCrawl, cachesToClear } from "@/lib/settings-effects";
import {
  SETTING_KEYS,
  ceilingFrom,
  deleteSetting,
  mergeSettings,
  readAllSettings,
  readCriteriaChangedAt,
  writeCriteriaChangedAt,
  writeSetting,
  type SettingKey,
} from "@/lib/settings-store";
import { rawQuery } from "@/lib/supabase";

export interface SettingsView {
  criteria: Criteria;
  ceiling: number | null;
  scoredJobCount: number;
  fitBrainOverridden: boolean;
  error?: string;
}

export async function getSettings(): Promise<SettingsView> {
  // ONE read of app_settings, then derive everything from those rows.
  // loadCriteria() would read it a second time, and layering readCeiling() on
  // top would make it three — three snapshots a concurrent save could split
  // the page across.
  const [rows, scored] = await Promise.all([readAllSettings(), countScoredJobs()]);
  return {
    criteria: mergeSettings(DEFAULT_CRITERIA, rows),
    ceiling: ceilingFrom(rows),
    scoredJobCount: scored.count,
    // Gates the rescore prompt across page loads — a client component has no
    // memory, so "re-show it this session" would bury it on a fresh load.
    fitBrainOverridden: rows.some((r) => r.key === SETTING_KEYS.fitBrain),
    error: scored.error,
  };
}

async function countScoredJobs(): Promise<{ count: number; error?: string }> {
  const { data, error } = await rawQuery<{ n: string }>(
    `select count(*) n from jobs where fit_score is not null`
  );
  if (error) {
    console.error(`settings: could not count scored jobs — ${error.message}`);
    // Surfaced rather than swallowed: the count is the only thing telling the
    // user how much a rescore will cost, and a silent 0 reads as "nothing to
    // rescore" — the one answer that makes the button look pointless when it
    // is not.
    return { count: 0, error: `Could not count scored roles — ${error.message}` };
  }
  return { count: Number(data?.[0]?.n ?? 0) };
}

/**
 * Everything a save of `key` must do beyond the write itself: drop the caches
 * the change invalidates, and stamp the criteria-changed timestamp when the
 * change alters what the crawler looks for.
 *
 * Single funnel for saves AND resets on purpose. A reset is a change to the
 * effective criteria exactly as much as a save is, and two copies of this
 * sequence would eventually disagree about which one stamps.
 */
async function applySideEffects(key: SettingKey): Promise<void> {
  for (const table of cachesToClear(key)) {
    // Table names come from a closed, hard-coded map keyed by SettingKey —
    // never from user input — so interpolation here cannot be injected into.
    const { error } = await rawQuery(`delete from ${table}`);
    if (error) {
      // Non-fatal: the setting itself is already saved. A surviving cache
      // serves stale results until it expires, which is worse than fresh but
      // far better than telling the user the save failed when it did not.
      console.error(`settings: could not clear ${table} — ${error.message}`);
    }
  }
  if (affectsCrawl(key)) {
    const { error } = await writeCriteriaChangedAt();
    if (error) {
      console.error(`settings: could not stamp criteria change — ${error}`);
    }
  }
}

export async function saveCriteriaList(
  key: SettingKey,
  label: string,
  items: string[]
): Promise<{ error?: string }> {
  const result = validateList(items, label);
  if (!result.ok) return { error: result.error };

  const { error } = await writeSetting(key, result.value);
  if (error) return { error: `Could not save ${label} — ${error}` };

  await applySideEffects(key);
  return {};
}

export async function saveCriteriaText(
  key: SettingKey,
  label: string,
  text: string
): Promise<{ error?: string }> {
  const trimmed = text.trim();
  if (!trimmed) return { error: `${label} cannot be empty.` };

  const { error } = await writeSetting(key, trimmed);
  if (error) return { error: `Could not save ${label} — ${error}` };

  await applySideEffects(key);
  return {};
}

export async function saveCeiling(n: number | null): Promise<{ error?: string }> {
  if (n !== null && (!Number.isInteger(n) || n < 1)) {
    return {
      error: "The search ceiling must be a whole number of at least 1, or off.",
    };
  }
  const { error } =
    n === null
      ? await deleteSetting(SETTING_KEYS.searchCeiling)
      : await writeSetting(SETTING_KEYS.searchCeiling, n);
  if (error) return { error: `Could not save the search ceiling — ${error}` };

  // A no-op today (the ceiling clears no cache and does not affect the
  // crawler), routed through the funnel anyway so the map stays the one place
  // that decides.
  await applySideEffects(SETTING_KEYS.searchCeiling);
  return {};
}

/** Deletes the stored override, so the shipped default takes over again. */
export async function resetSetting(key: SettingKey): Promise<{ error?: string }> {
  const { error } = await deleteSetting(key);
  if (error) return { error: `Could not reset — ${error}` };

  // Same side effects as a save, INCLUDING the AFFECTS_CRAWL gate. The brief
  // stamped unconditionally here; that would stamp on a fitBrain or ceiling
  // reset and suppress stale-posting closure for ~2 crawl cycles per company,
  // which is the exact behavior CRITERIA_CHANGED_AT_KEY's narrow scope exists
  // to prevent. Reverting to the default IS a criteria change — but only for
  // the same three keys a save counts.
  await applySideEffects(key);
  return {};
}

/** When the crawler-relevant criteria were last edited, or null if never. */
export async function getCriteriaChangedAt(): Promise<string | null> {
  return readCriteriaChangedAt();
}

interface JobRow {
  id: string;
  company: string;
  role_title: string;
  company_description: string | null;
  department: string | null;
  location: string | null;
  key_skills: string | null;
  fit_summary: string | null;
  arr: string | null;
  exit_signal: string | null;
  backer: string | null;
}

/**
 * Re-scores every job that already has a score, against the current fit brain.
 *
 * Offered rather than automatic: an edit that fixes a typo should not silently
 * spend money, and the user decides each time.
 *
 * Sequential by design — one Claude call per row, and a parallel fan-out over
 * a few hundred rows would hit rate limits rather than finish faster.
 */
export async function rescoreAll(): Promise<{
  rescored: number;
  failed: number;
  error?: string;
}> {
  const fitInputs = await loadScoringInputs();

  // rawQuery, NOT the builder — see SCORED_JOBS_SQL. `.neq("fit_score", null)`
  // matches zero rows and reports success.
  const { data, error } = await rawQuery<JobRow>(SCORED_JOBS_SQL);
  if (error) {
    return { rescored: 0, failed: 0, error: `Could not read jobs — ${error.message}` };
  }
  const rows = data ?? [];

  let rescored = 0;
  let scoreFailures = 0;
  let writeFailures = 0;

  for (const row of rows) {
    const scored = await scoreFit({
      company: row.company,
      role_title: row.role_title,
      company_description: row.company_description ?? "",
      key_skills: row.key_skills ?? "",
      fit_summary: row.fit_summary ?? "",
      department: row.department ?? "",
      location: row.location ?? "",
      arr: row.arr ?? undefined,
      exit_signal: row.exit_signal ?? undefined,
      backer: row.backer ?? undefined,
      fitInputs,
    });

    // scoreFit returns score 0 (not a throw) when the call or the JSON parse
    // fails. Writing that would violate the jobs.fit_score 1-5 check and, on a
    // permissive column, would silently wipe a good score.
    if (scored.score <= 0) {
      scoreFailures++;
      continue;
    }

    // Check the write before counting it. updateJob returns { error?: string };
    // lib/crawler.ts fixed exactly this "counted a failed write as a success"
    // bug already.
    //
    // fit_score ONLY. fit_summary is both an input to the prompt
    // (`Summary: ${opts.fit_summary}`) and was the field the original plan
    // overwrote with scored.rationale — rescore twice and the model is
    // summarizing its own previous rationale instead of the posting.
    const { error: updErr } = await updateJob(row.id, { fit_score: scored.score });
    if (updErr) {
      console.error(`rescoreAll: update failed for ${row.company} — ${updErr}`);
      writeFailures++;
      continue;
    }
    rescored++;
  }

  console.log(
    `rescoreAll: rescored ${rescored} of ${rows.length} scored jobs, ` +
      `${scoreFailures} scoring failures, ${writeFailures} write failures`
  );
  return { rescored, failed: scoreFailures + writeFailures };
}
