"use server";

import { updateJob } from "@/app/actions/jobs";
import { scoreFit } from "@/app/actions/parse-role";
import { validateList } from "@/lib/criteria-validation";
import { CRAWL_TITLE_MATCH_SQL, titleMatchPatterns } from "@/lib/removed-titles";
import {
  SCORED_JOBS_COUNT_SQL,
  SCORED_JOBS_REMAINING_SQL,
  SCORED_JOBS_SQL,
  clampRescoreLimit,
  passStartFrom,
  scoringArgsFor,
  type ScoredJobRow,
} from "@/lib/rescore-scope";
import { loadScoringInputs } from "@/lib/search-criteria";
import { affectsCrawl, cachesToClear } from "@/lib/settings-effects";
import {
  SETTING_KEYS,
  deleteSetting,
  type ListSettingKey,
  type TextSettingKey,
  readAllSettingsResult,
  readCriteriaChangedAt,
  writeCriteriaChangedAt,
  writeSetting,
  type SettingKey,
} from "@/lib/settings-store";
import { buildSettingsView, type SettingsView } from "@/lib/settings-view";
import { rawQuery } from "@/lib/supabase";

export async function getSettings(): Promise<SettingsView> {
  // ONE read of app_settings, then derive everything from those rows.
  // loadCriteria() would read it a second time, and layering readCeiling() on
  // top would make it three — three snapshots a concurrent save could split
  // the page across.
  //
  // readAllSettingsResult, NOT readAllSettings: this page is the one caller
  // that must NOT degrade silently to the shipped defaults. Rendering them as
  // if they were the user's saved values invites a save that overwrites the
  // real ones, and there is no history table.
  const [settings, scored] = await Promise.all([
    readAllSettingsResult(),
    countScoredJobs(),
  ]);
  return buildSettingsView({
    rows: settings.rows,
    settingsError: settings.error,
    scoredJobCount: scored.count,
    countError: scored.error,
  });
}

async function countScoredJobs(): Promise<{ count: number; error?: string }> {
  // Shares its `fit_score is not null` predicate with the rescore queries, so
  // the number shown to the user and the set rescoreAll walks cannot drift.
  const { data, error } = await rawQuery<{ n: string }>(SCORED_JOBS_COUNT_SQL);
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
 * How many crawler-found, untouched roles match a set of titles.
 *
 * Feeds the titles section's warning, which has to name a number: "editing
 * titles changes what the crawler hunts for" is abstract, "9 tracked roles
 * match titles you are removing" is not. Called with the titles the draft is
 * DROPPING, so it answers "what stops being monitored if I save this".
 *
 * Reads nothing else and writes nothing — safe to call on every keystroke's
 * debounce.
 */
export async function countCrawlJobsMatchingTitles(
  titles: string[]
): Promise<{ count: number; error?: string }> {
  const patterns = titleMatchPatterns(titles);
  // No patterns means nothing is being removed. `ilike any('{}')` matches zero
  // rows and would answer 0 correctly, but spending a round trip to learn that
  // on every keystroke is pointless.
  if (patterns.length === 0) return { count: 0 };

  const { data, error } = await rawQuery<{ n: string }>(CRAWL_TITLE_MATCH_SQL, [
    patterns,
  ]);
  if (error) {
    console.error(`settings: could not count roles matching titles — ${error.message}`);
    // Surfaced, not swallowed as 0: "0 tracked roles match" is a specific
    // reassurance, and giving it when the count actually failed would tell the
    // user a title removal is free when it may not be.
    return { count: 0, error: `Could not count matching roles — ${error.message}` };
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
  key: ListSettingKey,
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
  key: TextSettingKey,
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

  // Same side effects as a save, INCLUDING the AFFECTS_CRAWL gate. The plan
  // stamped unconditionally here; that would stamp on a fitBrain or ceiling
  // reset and suppress stale-posting closure for ~2 crawl cycles per company,
  // which is the exact behavior CRITERIA_CHANGED_AT_KEY's narrow scope exists
  // to prevent. Reverting to the default IS a criteria change — but only for
  // the same keys a save counts.
  await applySideEffects(key);
  return {};
}

/** When the crawler-relevant criteria were last edited, or null if never. */
export async function getCriteriaChangedAt(): Promise<string | null> {
  return readCriteriaChangedAt();
}

export interface RescoreResult {
  /** Rows re-scored and successfully written in THIS batch. */
  rescored: number;
  /** Rows in this batch that failed to score or failed to write. */
  failed: number;
  /**
   * Scored rows this pass has not finished yet. Not a drain condition on its
   * own — a permanently failing row keeps it above zero forever. Loop while
   * `remaining > 0 && rescored > 0`.
   */
  remaining: number;
  /**
   * The pass timestamp `remaining` was counted against. Returned so the caller
   * can hand it back on the next batch — see `passStartFrom`. Dropping this
   * from the loop makes every batch count the previous batches' finished rows
   * as still outstanding, so `remaining` never reaches zero.
   */
  passStartedAt: string;
  error?: string;
}

/**
 * Re-scores one bounded batch of already-scored jobs against the current fit
 * brain, oldest-touched first.
 *
 * Offered rather than automatic: an edit that fixes a typo should not silently
 * spend money, and the user decides each time.
 *
 * Batched rather than exhaustive because a server action gets one request
 * lifetime. At ~$0.0076 and a couple of seconds per scoreFit call, an
 * unbounded pass over a few hundred rows outruns any timeout and loses its own
 * return value — the caller never learns how many rows landed. The caller
 * drives the loop instead, and sees a count after every batch.
 *
 * Sequential within the batch by design: a parallel fan-out would hit rate
 * limits rather than finish faster.
 *
 * `passStartedAt` scopes `remaining` to the WHOLE pass. The first batch omits
 * it and gets the server's clock back in the result; every later batch must
 * pass that value in. See passStartFrom in lib/rescore-scope.ts — a per-batch
 * timestamp makes `remaining` uncloseable and bills full extra passes.
 */
export async function rescoreAll(opts?: {
  limit?: number;
  passStartedAt?: string;
}): Promise<RescoreResult> {
  // Taken before the first write, so `remaining` counts rows THE PASS has not
  // touched. updateJob stamps updated_at, which is also what moves finished
  // rows to the back of SCORED_JOBS_SQL's ordering.
  const passStartedAt = passStartFrom(opts?.passStartedAt);
  const limit = clampRescoreLimit(opts?.limit);
  const fitInputs = await loadScoringInputs();

  // rawQuery, NOT the builder — see SCORED_JOBS_SQL. `.neq("fit_score", null)`
  // matches zero rows and reports success.
  const { data, error } = await rawQuery<ScoredJobRow>(SCORED_JOBS_SQL, [limit]);
  if (error) {
    return {
      rescored: 0,
      failed: 0,
      remaining: 0,
      passStartedAt,
      error: `Could not read jobs — ${error.message}`,
    };
  }
  const rows = data ?? [];

  let rescored = 0;
  let scoreFailures = 0;
  let writeFailures = 0;

  for (const row of rows) {
    // scoringArgsFor, not an inline literal: arr / exit_signal / backer are
    // OPTIONAL on scoreFit's opts, so dropping them inline would compile and
    // pass while rescoring blind. See lib/rescore-scope.ts.
    const scored = await scoreFit({ ...scoringArgsFor(row), fitInputs });

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

  const remaining = await countRemaining(passStartedAt);
  console.log(
    `rescoreAll: batch of ${rows.length} (limit ${limit}) — rescored ${rescored}, ` +
      `${scoreFailures} scoring failures, ${writeFailures} write failures, ` +
      `${remaining} still to do`
  );
  return {
    rescored,
    failed: scoreFailures + writeFailures,
    remaining,
    passStartedAt,
  };
}

async function countRemaining(passStartedAt: string): Promise<number> {
  const { data, error } = await rawQuery<{ n: string }>(SCORED_JOBS_REMAINING_SQL, [
    passStartedAt,
  ]);
  if (error) {
    // The batch itself already succeeded; only the "how much is left" figure
    // is missing. 0 stops the caller's loop, which is the recoverable failure:
    // the user clicks Rescore again and the next batch picks up where this one
    // stopped. Guessing a positive number would keep an automated loop
    // spending money on a count nobody can verify.
    console.error(`rescoreAll: could not count remaining rows — ${error.message}`);
    return 0;
  }
  return Number(data?.[0]?.n ?? 0);
}
