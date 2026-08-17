"use server";

import { requireActor } from "@/lib/require-actor";

import { revalidatePath } from "next/cache";
import { updateJob } from "@/app/actions/jobs";
import { scoreFit } from "@/app/actions/parse-role";
import { validateList } from "@/lib/criteria-validation";
import { passDrained } from "@/lib/rescore-progress";
import { CRAWL_TITLE_MATCH_SQL, titleMatchPatterns } from "@/lib/removed-titles";
import {
  SCORED_JOBS_COUNT_SQL,
  SCORED_JOBS_REMAINING_SQL,
  SCORED_JOBS_SQL,
  clampRescoreLimit,
  tallyRescoreOutcomes,
  type RescoreOutcome,
  passStartFrom,
  remainingCountFrom,
  scoringArgsFor,
  type ScoredJobRow,
} from "@/lib/rescore-scope";
import { loadScoringInputs } from "@/lib/search-criteria";
import { affectsCrawl, cachesToClear, pathsToRevalidate } from "@/lib/settings-effects";
import {
  SETTING_KEYS,
  UNDESCRIBED_DB_ERROR,
  deleteSetting,
  describeWriteFailure,
  type ListSettingKey,
  type TextSettingKey,
  readAllSettingsResult,
  readCriteriaChangedAt,
  writeCompScoringRescoredAt,
  writeCriteriaChangedAt,
  writeSetting,
  type SettingKey,
} from "@/lib/settings-store";
import { buildSettingsView, type SettingsView } from "@/lib/settings-view";
import { rawQuery } from "@/lib/supabase";

export async function getSettings(): Promise<SettingsView> {
  // Session required. Server Actions are RPC endpoints addressed by an ID that
  // ships in the client bundle, so a page-level check does not cover them.
  await requireActor();
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
    // `|| UNDESCRIBED_DB_ERROR` for the same reason readAllSettings uses it: pg
    // with no DATABASE_URL rejects with an EMPTY message, and both the log line
    // and the user-facing string below would otherwise trail off after the dash
    // saying nothing. Guaranteeing this is non-empty is also what lets
    // buildSettingsView treat a present countError as a real problem.
    const why = error.message || UNDESCRIBED_DB_ERROR;
    console.error(`settings: could not count scored jobs — ${why}`);
    // Surfaced rather than swallowed: the count is the only thing telling the
    // user how much a rescore will cost, and a silent 0 reads as "nothing to
    // rescore" — the one answer that makes the button look pointless when it
    // is not.
    return { count: 0, error: `Could not count scored roles — ${why}` };
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
  // Session required. Server Actions are RPC endpoints addressed by an ID that
  // ships in the client bundle, so a page-level check does not cover them.
  await requireActor();
  const patterns = titleMatchPatterns(titles);
  // No patterns means nothing is being removed. `ilike any('{}')` matches zero
  // rows and would answer 0 correctly, but spending a round trip to learn that
  // on every keystroke is pointless.
  if (patterns.length === 0) return { count: 0 };

  const { data, error } = await rawQuery<{ n: string }>(CRAWL_TITLE_MATCH_SQL, [
    patterns,
  ]);
  if (error) {
    // `|| UNDESCRIBED_DB_ERROR` for the same reason its sibling countScoredJobs
    // uses it, twenty lines up: without it both strings trail off after the
    // dash saying nothing. The failure is still REPORTED either way (the
    // prefix keeps the string non-empty), so this is the one purely cosmetic
    // fix in this sweep — taken only because the file was already open.
    const why = error.message || UNDESCRIBED_DB_ERROR;
    console.error(`settings: could not count roles matching titles — ${why}`);
    // Surfaced, not swallowed as 0: "0 tracked roles match" is a specific
    // reassurance, and giving it when the count actually failed would tell the
    // user a title removal is free when it may not be.
    return { count: 0, error: `Could not count matching roles — ${why}` };
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
    // Presence for the branch, substitution for the text: this one is
    // log-only (the save itself already landed), but an `if (error)` here made
    // the log line conditional on the driver having bothered to describe
    // itself — which is exactly when a log line is most needed.
    const described = describeWriteFailure(error, "stamp the criteria change");
    if (described !== undefined) console.error(`settings: ${described}`);
  }
  // Evicts the server AND client caches for any route that renders this
  // setting. force-dynamic alone leaves Next 14's Router Cache serving a
  // prefetched /roles with the old floor for ~30s after a save — see
  // PATHS_TO_REVALIDATE.
  for (const path of pathsToRevalidate(key)) {
    revalidatePath(path);
  }
}

export async function saveCriteriaList(
  key: ListSettingKey,
  label: string,
  items: string[]
): Promise<{ error?: string }> {
  // Session required. Server Actions are RPC endpoints addressed by an ID that
  // ships in the client bundle, so a page-level check does not cover them.
  await requireActor();
  const result = validateList(items, label);
  if (!result.ok) return { error: result.error };

  const { error } = await writeSetting(key, result.value);
  // describeWriteFailure, not `if (error)` — presence, not truthiness. See
  // saveCompFloor below for the full account; the amplification is worse here
  // than the wrong banner suggests. A swallowed failure falls through to
  // applySideEffects, which DELETES the discovered_roles / role_searches
  // caches (forcing a re-billed search) and stamps criteria_changed_at, which
  // suppresses stale-posting closure for ~2 crawl cycles per company — all on
  // the strength of an edit that was never stored. Meanwhile Settings.tsx
  // shows "Saved." and syncSection replaces the user's typed draft with
  // whatever the re-read returned. There is no history table.
  const described = describeWriteFailure(error, `save ${label}`);
  if (described !== undefined) {
    console.error(`settings: ${described}`);
    return { error: described };
  }

  await applySideEffects(key);
  return {};
}

export async function saveCriteriaText(
  key: TextSettingKey,
  label: string,
  text: string
): Promise<{ error?: string }> {
  // Session required. Server Actions are RPC endpoints addressed by an ID that
  // ships in the client bundle, so a page-level check does not cover them.
  await requireActor();
  const trimmed = text.trim();
  if (!trimmed) return { error: `${label} cannot be empty.` };

  const { error } = await writeSetting(key, trimmed);
  // Presence, not truthiness — see saveCriteriaList. This is the path the fit
  // brain travels, which makes it the costliest of the four: a swallowed
  // failure has Settings.tsx report "Saved." and then syncSection overwrite
  // the textarea with the re-read value, so a long hand-written prompt is
  // gone from the screen and was never in the database.
  const described = describeWriteFailure(error, `save ${label}`);
  if (described !== undefined) {
    console.error(`settings: ${described}`);
    return { error: described };
  }

  await applySideEffects(key);
  return {};
}

export async function saveCeiling(n: number | null): Promise<{ error?: string }> {
  // Session required. Server Actions are RPC endpoints addressed by an ID that
  // ships in the client bundle, so a page-level check does not cover them.
  await requireActor();
  if (n !== null && (!Number.isInteger(n) || n < 1)) {
    return {
      error: "The search ceiling must be a whole number of at least 1, or off.",
    };
  }
  const { error } =
    n === null
      ? await deleteSetting(SETTING_KEYS.searchCeiling)
      : await writeSetting(SETTING_KEYS.searchCeiling, n);
  // Presence, not truthiness — see saveCriteriaList.
  const described = describeWriteFailure(error, "save the search ceiling");
  if (described !== undefined) {
    console.error(`settings: ${described}`);
    return { error: described };
  }

  // A no-op today (the ceiling clears no cache and does not affect the
  // crawler), routed through the funnel anyway so the map stays the one place
  // that decides.
  await applySideEffects(SETTING_KEYS.searchCeiling);
  return {};
}

/**
 * The minimum acceptable base compensation, or null to turn the floor off.
 *
 * Same validation as saveCeiling, and for the same reason: `0` is not a valid
 * "off" spelling here (that is what `null` is for) — a stored `0` would render
 * a "Meets minimum" toggle that does nothing, because every truthiness check
 * downstream (`floorLine`, the /roles filter) treats `0` the same as "not
 * set", silently turning the floor into a no-op instead of the strict
 * $0-or-more filter its value implies.
 *
 * Routed through applySideEffects like every other save/reset in this file,
 * even though CACHES_TO_CLEAR and AFFECTS_CRAWL both currently resolve
 * compFloor to "nothing to do" — so if that ever changes, this action picks
 * it up automatically instead of silently bypassing the one funnel that
 * decides.
 *
 * Deliberately NOT saveCriteriaList/saveCriteriaText: both are shape-typed to
 * ListSettingKey/TextSettingKey, and compFloor is neither — passing it to
 * either is a compile error by design (see NUMBER_SETTING_KEYS in
 * lib/settings-store.ts).
 */
export async function saveCompFloor(n: number | null): Promise<{ error?: string }> {
  // Session required. Server Actions are RPC endpoints addressed by an ID that
  // ships in the client bundle, so a page-level check does not cover them.
  await requireActor();
  if (n !== null && (!Number.isInteger(n) || n < 1)) {
    return {
      error: "The minimum base must be a whole number of at least 1, or off.",
    };
  }
  const { error } =
    n === null
      ? await deleteSetting(SETTING_KEYS.compFloor)
      : await writeSetting(SETTING_KEYS.compFloor, n);
  // describeWriteFailure, not `if (error)`. Presence, not truthiness: pg with an
  // unset or unreachable DATABASE_URL rejects with an EMPTY message, which is
  // falsy — the truthiness spelling returned {} for a write that never landed,
  // so the page reported a saved floor, armed the rescore offer, and billed a
  // pass against a floor that was not stored. Nothing in the build or the log
  // would have said so.
  const described = describeWriteFailure(error, "save the minimum base");
  if (described !== undefined) {
    console.error(`settings: ${described}`);
    return { error: described };
  }

  await applySideEffects(SETTING_KEYS.compFloor);
  return {};
}

/** Deletes the stored override, so the shipped default takes over again. */
export async function resetSetting(key: SettingKey): Promise<{ error?: string }> {
  // Session required. Server Actions are RPC endpoints addressed by an ID that
  // ships in the client bundle, so a page-level check does not cover them.
  await requireActor();
  const { error } = await deleteSetting(key);
  // Presence, not truthiness — see saveCriteriaList. A reset is a change to
  // the effective criteria exactly as much as a save is, so a swallowed
  // failure here runs the same cache-clearing, stamp-writing side effects for
  // a row that was never deleted.
  const described = describeWriteFailure(error, "reset it");
  if (described !== undefined) {
    console.error(`settings: ${described}`);
    return { error: described };
  }

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
  // Session required. Server Actions are RPC endpoints addressed by an ID that
  // ships in the client bundle, so a page-level check does not cover them.
  await requireActor();
  return readCriteriaChangedAt();
}

/**
 * Records that a rescore pass finished, so the compensation offer stops firing
 * on every page load.
 *
 * A thin pass-through, and only that. The write itself stays in
 * lib/settings-store.ts next to the key it uses — a writer here would have to
 * widen `SettingKey` to reach that key, which is the typo hazard the constant
 * exists to close. This exists solely because the settings page is a client
 * component and cannot import settings-store: doing so would drag `pg` into the
 * client bundle.
 *
 * Deliberately NOT called from inside rescoreAll. rescoreAll runs one BATCH; a
 * stamp written there would fire on the first of several and suppress the offer
 * while most of the pipeline still carried stale scores. The caller stamps, and
 * only when the whole pass drained cleanly.
 *
 * It takes the whole pass and re-applies `passDrained` rather than trusting the
 * caller to have checked. Two independent bounds, the same idiom runRescorePass
 * uses — because the caller's check lives in a React component, where no test
 * in this repo can reach it: a review moved that call one line up, outside its
 * `if`, and the suite stayed green while a partial pass retired the offer
 * permanently. With the rule enforced here too, that edit becomes a no-op
 * instead of a silent data-stranding bug. Returns `stamped` so a caller can
 * tell "refused" from "written".
 */
export async function markCompScoringRescored(pass: {
  rescored: number;
  remaining: number | null;
  error?: string;
}): Promise<{ error?: string; stamped: boolean }> {
  // Session required. Server Actions are RPC endpoints addressed by an ID that
  // ships in the client bundle, so a page-level check does not cover them.
  await requireActor();
  if (!passDrained(pass)) {
    console.warn(
      `settings: refusing to stamp the compensation rescore — the pass did not ` +
        `drain (rescored ${pass.rescored}, remaining ${pass.remaining ?? "uncounted"}` +
        `${pass.error === undefined ? "" : `, error ${pass.error || "(undescribed)"}`})`
    );
    return { stamped: false };
  }
  const { error } = await writeCompScoringRescoredAt();
  // describeWriteFailure, not `if (error)`. Presence, not truthiness: pg with
  // no DATABASE_URL rejects with an EMPTY message, so the truthiness spelling
  // that shipped here reported a hard write failure as a clean stamp — the
  // same defect readAllSettings once had, in a place where it would tell the
  // user the offer was retired when nothing had been written.
  const described = describeWriteFailure(error, "record that the rescore ran");
  if (described !== undefined) {
    console.error(`settings: ${described}`);
    return { error: described, stamped: false };
  }
  return { stamped: true };
}

export interface RescoreResult {
  /** Rows re-scored and successfully written in THIS batch. */
  rescored: number;
  /** Rows in this batch that failed to score or failed to write. */
  failed: number;
  /**
   * Scored rows this pass has not finished yet, or **null when the count query
   * itself failed**.
   *
   * Not a drain condition on its own — a permanently failing row keeps it above
   * zero forever. Loop while `remaining > 0 && rescored > 0`.
   *
   * Null rather than 0 for the failure, and that distinction is load-bearing:
   * 0 is what authorizes writing the PERMANENT `comp_scoring_rescored_at`
   * stamp. Reporting a failed count as 0 turned "the count blipped" into "the
   * pass drained", stamped it, and left the untouched rows stale forever with
   * nothing on screen but a success message. See passDrained in
   * lib/rescore-progress.ts.
   */
  remaining: number | null;
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
  // Session required. Server Actions are RPC endpoints addressed by an ID that
  // ships in the client bundle, so a page-level check does not cover them.
  await requireActor();
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

  // Concurrent, matching lib/ingest-roles.ts, which fires scoreFit for every
  // new role with Promise.all. This loop was serial and a 41-role rescore took
  // minutes of wall clock for work the repo already does in parallel
  // elsewhere. The batch cap (clampRescoreLimit) is what makes the fan-out
  // bounded rather than unbounded.
  //
  // Each callback returns an outcome instead of incrementing a shared counter,
  // and every one is wrapped: an unhandled throw from scoreFit would reject
  // Promise.all and discard the tally for rows that had already written
  // successfully, reporting zero for work that actually happened.
  const outcomes = await Promise.all(
    rows.map(async (row): Promise<RescoreOutcome> => {
      try {
        // scoringArgsFor, not an inline literal: arr / exit_signal / backer are
        // OPTIONAL on scoreFit's opts, so dropping them inline would compile and
        // pass while rescoring blind. See lib/rescore-scope.ts.
        const scored = await scoreFit({ ...scoringArgsFor(row), fitInputs });

        // scoreFit returns score 0 (not a throw) when the call or the JSON parse
        // fails. Writing that would violate the jobs.fit_score 1-5 check and, on
        // a permissive column, would silently wipe a good score.
        if (scored.score <= 0) return "score-failed";

        // Check the write before counting it. updateJob returns { error?: string };
        // lib/crawler.ts fixed exactly this "counted a failed write as a success"
        // bug already.
        //
        // fit_score ONLY. fit_summary is both an input to the prompt
        // (`Summary: ${opts.fit_summary}`) and was the field the original plan
        // overwrote with scored.rationale — rescore twice and the model is
        // summarizing its own previous rationale instead of the posting.
        const { error: updErr } = await updateJob(row.id, { fit_score: scored.score });
        // describeWriteFailure, not `if (updErr)`. Presence, not truthiness, and
        // the stakes here are higher than anywhere else this doctrine applies:
        // updateJob returns `error.message` verbatim, pg with an unset or
        // unreachable DATABASE_URL rejects with an EMPTY one, and an empty
        // string is falsy. The failed row then counts as "rescored", which
        // inflates pass.rescored, which satisfies passDrained's
        // `rescored > 0 && remaining === 0`, which writes the PERMANENT
        // comp_scoring_rescored_at stamp — and the day-one offer never returns.
        // The rows are stale forever with nothing on screen but a success
        // message. That is the same stranding fix round 1 closed from the
        // remaining-count side; this is the other input to the same bound.
        const described = describeWriteFailure(updErr, `write ${row.company}'s new score`);
        if (described !== undefined) {
          console.error(`rescoreAll: ${described}`);
          return "write-failed";
        }
        return "rescored";
      } catch (err) {
        console.error(
          `rescoreAll: ${row.company} threw — ${err instanceof Error ? err.message : String(err)}`
        );
        return "score-failed";
      }
    })
  );

  const { rescored, scoreFailures, writeFailures } = tallyRescoreOutcomes(outcomes);

  const remaining = await countRemaining(passStartedAt);
  console.log(
    `rescoreAll: batch of ${rows.length} (limit ${limit}) — rescored ${rescored}, ` +
      `${scoreFailures} scoring failures, ${writeFailures} write failures, ` +
      `${remaining === null ? "an uncounted number" : remaining} still to do`
  );
  return {
    rescored,
    failed: scoreFailures + writeFailures,
    remaining,
    passStartedAt,
  };
}

async function countRemaining(passStartedAt: string): Promise<number | null> {
  const { data, error } = await rawQuery<{ n: string }>(SCORED_JOBS_REMAINING_SQL, [
    passStartedAt,
  ]);
  if (error) {
    console.error(
      `rescoreAll: could not count remaining rows — ${error.message || UNDESCRIBED_DB_ERROR}`
    );
  }
  // remainingCountFrom, not an inline `return 0` on the failure branch. NULL,
  // not 0. Both stop the caller's loop — which is still the right recoverable
  // behavior, since guessing a positive number would keep an automated loop
  // spending money on a count nobody can verify — but 0 ALSO reads as "this
  // pass drained", and that answer is now permanent: it authorizes the
  // comp_scoring_rescored_at stamp. A blip here used to be enough to strand
  // every untouched row and retire the offer, reporting only "Rescored 25
  // roles." Null says "unknown", which suppresses nothing. The rule lives in
  // lib/rescore-scope.ts so it is pinned by a test; nothing in this module can
  // be.
  return remainingCountFrom(data, error);
}
