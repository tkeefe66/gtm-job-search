import { beforeEach, describe, expect, test, vi } from "vitest";

// The budget wrapper is bypassed: this suite asserts how a rescore batch COUNTS
// rows, and withBudget reaches the database for tiers, ceilings and counters
// before any of that runs. Budget behaviour is pinned in lib/budget.test.ts and
// the reservation is proven against a real database.
vi.mock("@/lib/metered", () => ({
  withBudget: async (o: { fn: () => Promise<unknown> }) => ({ result: await o.fn() }),
}));


// The session guard is mocked, not exercised: these tests are about each
// action's own failure reporting, and requireActor() would otherwise throw
// before any of that ran. That the guard EXISTS on every action is asserted
// separately, in app/actions/auth-required.test.ts — mocking it here would
// otherwise quietly delete that coverage.
vi.mock("@/lib/require-actor", () => ({
  requireActor: async () => ({
    userId: "test-user",
    tenantId: "test-user",
    email: "test@example.com",
    isAdmin: false,
  }),
}));


// Everything in this action's graph that reaches the network, replaced. What is
// left is the decision-making, which is the whole point: this module was
// written off as untestable because it is `"use server"`, and that was wrong.
// `markCompScoringRescored`'s guard returns BEFORE any query, so pinning it
// needs no database, no Anthropic key, and about two milliseconds.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ rawQuery: vi.fn(), supabase: {} }));
vi.mock("@/app/actions/jobs", () => ({ updateJob: vi.fn() }));
vi.mock("@/app/actions/parse-role", () => ({ scoreFit: vi.fn() }));
vi.mock("@/lib/settings-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings-store")>()),
  writeCompScoringRescoredAt: vi.fn(),
  writeSetting: vi.fn(),
  deleteSetting: vi.fn(),
}));

import {
  markCompScoringRescored,
  rescoreAll,
  resetSetting,
  saveCeiling,
  saveCompFloor,
  saveCriteriaList,
  saveCriteriaText,
} from "./settings";
import { updateJob } from "@/app/actions/jobs";
import { scoreFit } from "@/app/actions/parse-role";
import {
  SCORED_JOBS_REMAINING_SQL,
  SCORED_JOBS_SQL,
  type ScoredJobRow,
} from "@/lib/rescore-scope";
import {
  SETTING_KEYS,
  deleteSetting,
  writeCompScoringRescoredAt,
  writeSetting,
} from "@/lib/settings-store";
import { rawQuery } from "@/lib/supabase";

const write = vi.mocked(writeCompScoringRescoredAt);
const writeKey = vi.mocked(writeSetting);
const deleteKey = vi.mocked(deleteSetting);
const query = vi.mocked(rawQuery);
const update = vi.mocked(updateJob);
const score = vi.mocked(scoreFit);

/** A pass that drained cleanly — the ONLY shape allowed to stamp. */
const DRAINED = { rescored: 26, remaining: 0 };

/** One already-scored row, the shape SCORED_JOBS_SQL selects. */
const ROW: ScoredJobRow = {
  id: "job-1",
  company: "Acme",
  role_title: "RevOps Lead",
  company_description: null,
  department: null,
  location: null,
  key_skills: null,
  fit_summary: null,
  salary_range: "$180,000 - $220,000",
  arr: null,
  exit_signal: null,
  backer: null,
};

beforeEach(() => {
  write.mockReset();
  write.mockResolvedValue({});
  update.mockReset();
  update.mockResolvedValue({});
  score.mockReset();
  score.mockResolvedValue({ score: 4, rationale: "solid" });
  writeKey.mockReset();
  writeKey.mockResolvedValue({});
  deleteKey.mockReset();
  deleteKey.mockResolvedValue({});
  query.mockReset();
  query.mockResolvedValue({ data: [], error: null } as never);
});

describe("markCompScoringRescored — the second bound on the stamp", () => {
  // The guard exists because the FIRST bound lives in a React component, where
  // no test in this repo can reach it: a review moved that call one line up,
  // out of its `if`, and the suite stayed green while a partial pass retired
  // the day-one offer permanently. Until now this half of the pair was the
  // unpinned one.

  test("a drained pass stamps, exactly once", async () => {
    // The positive control. Without it every "did not write" assertion below
    // would pass against a function that never writes at all.
    const res = await markCompScoringRescored(DRAINED);
    expect(res).toEqual({ stamped: true });
    expect(write).toHaveBeenCalledTimes(1);
  });

  test("a pass with rows still to do is refused", async () => {
    const res = await markCompScoringRescored({ rescored: 25, remaining: 75 });
    expect(res.stamped).toBe(false);
    expect(res.error).toBeUndefined();
    expect(write).not.toHaveBeenCalled();
  });

  test("an UNCOUNTED remainder is refused, not treated as zero", async () => {
    // The Medium defect's last line of defence. `remaining: null` reaching here
    // means the count query failed; stamping on it strands every row the pass
    // did not reach, permanently, with a success message on screen.
    const res = await markCompScoringRescored({ rescored: 25, remaining: null });
    expect(res.stamped).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  test("a failed pass is refused, described or not", async () => {
    expect((await markCompScoringRescored({ ...DRAINED, error: "boom" })).stamped).toBe(
      false
    );
    // Presence, not truthiness — an empty driver message is still a failure.
    expect((await markCompScoringRescored({ ...DRAINED, error: "" })).stamped).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  test("a pass that scored nothing is refused", async () => {
    expect((await markCompScoringRescored({ rescored: 0, remaining: 0 })).stamped).toBe(
      false
    );
    expect(write).not.toHaveBeenCalled();
  });

  test("a failed WRITE is reported rather than reported as stamped", async () => {
    write.mockResolvedValue({ error: "read-only transaction" });
    const res = await markCompScoringRescored(DRAINED);
    expect(res.stamped).toBe(false);
    expect(res.error).toContain("read-only transaction");
  });

  test("a write that failed with NO message still reports a failure", async () => {
    // pg with no DATABASE_URL rejects with an empty message. `if (error)` reads
    // that as a clean stamp and tells the user the offer is retired when
    // nothing was written — the defect readAllSettings shipped once already.
    write.mockResolvedValue({ error: "" });
    const res = await markCompScoringRescored(DRAINED);
    expect(res.stamped).toBe(false);
    expect(res.error).toBeDefined();
    expect(res.error).not.toMatch(/—\s*$/);
  });
});

describe("saveCompFloor reports a write that failed", () => {
  test("a stored floor is written under its own key", async () => {
    // Both sides of the branch: without this, "always report a failure" passes.
    expect(await saveCompFloor(180000)).toEqual({});
    expect(writeKey).toHaveBeenCalledWith(SETTING_KEYS.compFloor, 180000);
  });

  test("a write that failed with NO message is a failure, not a save", async () => {
    // The sixth instance of this branch's own recurring bug. pg with an unset or
    // unreachable DATABASE_URL rejects with an EMPTY message, which is falsy, so
    // `if (error)` returned {} for a write that never landed: the page said
    // "Saved.", armed the rescore offer, and billed a pass against a floor that
    // was not stored — with nothing in the build or the log to say so.
    writeKey.mockResolvedValue({ error: "" });
    const res = await saveCompFloor(180000);
    expect(res.error).toBeDefined();
    // And it does not trail off after the dash with nothing behind it.
    expect(res.error).not.toMatch(/—\s*$/);
  });

  test("turning the floor OFF reports its failure the same way", async () => {
    // The delete path is a separate call with the same spelling hazard.
    deleteKey.mockResolvedValue({ error: "" });
    const res = await saveCompFloor(null);
    expect(deleteKey).toHaveBeenCalledWith(SETTING_KEYS.compFloor);
    expect(res.error).toBeDefined();
  });

  test("a described failure keeps the driver's own words", async () => {
    writeKey.mockResolvedValue({ error: "read-only transaction" });
    expect((await saveCompFloor(180000)).error).toContain("read-only transaction");
  });
});

describe("rescoreAll counts a row only when its write landed", () => {
  /** One row through the batch, with the remaining count answering `remaining`. */
  function oneRowBatch(remaining = "0") {
    query.mockImplementation((sql: string) => {
      if (sql === SCORED_JOBS_SQL) return { data: [ROW], error: null } as never;
      if (sql === SCORED_JOBS_REMAINING_SQL) {
        return { data: [{ n: remaining }], error: null } as never;
      }
      return { data: [], error: null } as never;
    });
  }

  test("a write that landed counts as rescored", async () => {
    // Both directions, and this is the half that matters most: a rule that
    // counted NOTHING as rescored would pass the failure tests below on its own,
    // and would also stop the pass from ever draining.
    oneRowBatch();
    const res = await rescoreAll();
    expect(update).toHaveBeenCalledWith("job-1", { fit_score: 4 });
    expect(res.rescored).toBe(1);
    expect(res.failed).toBe(0);
  });

  test("a write that failed with NO message counts as FAILED, not rescored", async () => {
    // updateJob returns `error.message` verbatim and pg with an unset or
    // unreachable DATABASE_URL rejects with an empty one. `if (updErr)` skipped
    // the failure path and returned "rescored" for a row that was never written.
    update.mockResolvedValue({ error: "" });
    oneRowBatch();
    const res = await rescoreAll();
    expect(res.rescored).toBe(0);
    expect(res.failed).toBe(1);
  });

  test("a described write failure counts as failed too", async () => {
    // The other side of describeWriteFailure's presence check: passing it
    // `undefined` instead of the real error makes every write look clean.
    update.mockResolvedValue({ error: "deadlock detected" });
    oneRowBatch();
    const res = await rescoreAll();
    expect(res.rescored).toBe(0);
    expect(res.failed).toBe(1);
  });

  test("a failed write is logged as a WRITE failure, not a scoring one", async () => {
    // `failed` sums both kinds, so the counts alone cannot tell them apart —
    // returning "score-failed" for a failed write keeps every number in the
    // return value identical. The batch log line is the only place the
    // difference shows, and it is what tells an operator whether the database
    // or the model is the thing that broke.
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      update.mockResolvedValue({ error: "" });
      oneRowBatch();
      await rescoreAll();
      expect(log).toHaveBeenCalledTimes(1);
      expect(String(log.mock.calls[0][0])).toContain("0 scoring failures, 1 write failures");
    } finally {
      log.mockRestore();
    }
  });

  test("a scoring failure is logged as a SCORING failure, not a write one", async () => {
    // The mirror of the test above, and the same blind spot: scoreFit returns
    // score 0 rather than throwing when the call or the JSON parse fails, and
    // labelling that "write-failed" leaves every returned number identical
    // while telling an operator the database broke when the model did.
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      score.mockResolvedValue({ score: 0, rationale: "" });
      oneRowBatch();
      const res = await rescoreAll();
      expect(res.rescored).toBe(0);
      expect(res.failed).toBe(1);
      // No write was even attempted — the score never got past the 1-5 check.
      expect(update).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledTimes(1);
      expect(String(log.mock.calls[0][0])).toContain("1 scoring failures, 0 write failures");
    } finally {
      log.mockRestore();
    }
  });

  test("an empty-message write failure cannot reach the permanent stamp", async () => {
    // Why this line is a stamp-correctness bug and not a tally nit. Counted as
    // rescored, the batch reports rescored 1 / remaining 0 — which satisfies
    // passDrained — and writes comp_scoring_rescored_at, retiring the day-one
    // offer FOREVER over rows that were never written. Same stranding fix round
    // 1 closed from the remaining-count side, through the other input.
    update.mockResolvedValue({ error: "" });
    oneRowBatch();
    const pass = await rescoreAll();
    expect((await markCompScoringRescored(pass)).stamped).toBe(false);
    expect(write).not.toHaveBeenCalled();
    // And the same pass with the write LANDING does stamp, so the assertion
    // above is about the failure and not about the fixture.
    update.mockResolvedValue({});
    oneRowBatch();
    expect((await markCompScoringRescored(await rescoreAll())).stamped).toBe(true);
  });
});

describe("rescoreAll's remaining count", () => {
  /**
   * Drives one batch over ZERO scored rows, so no scoreFit and no updateJob
   * runs and the only thing under test is how the remaining count is reported.
   * The batch query answers first, the remaining query second.
   */
  function batchWithRemaining(remaining: { data: unknown; error: unknown }) {
    query.mockImplementation((sql: string) => {
      if (sql === SCORED_JOBS_SQL) return { data: [], error: null } as never;
      if (sql === SCORED_JOBS_REMAINING_SQL) return remaining as never;
      return { data: [], error: null } as never;
    });
  }

  test("a successful count comes back as a number", async () => {
    batchWithRemaining({ data: [{ n: "75" }], error: null });
    expect((await rescoreAll()).remaining).toBe(75);
  });

  test("a FAILED count comes back as null, never as a drained zero", async () => {
    // The Medium at its source. `0` here is indistinguishable from "this pass
    // finished", which is the one answer that authorizes the permanent stamp.
    batchWithRemaining({ data: [], error: { message: "connection terminated" } });
    expect((await rescoreAll()).remaining).toBeNull();
  });

  test("a genuinely empty count is still a real zero", async () => {
    // Both sides of the branch. Without this, "always return null" passes.
    batchWithRemaining({ data: [{ n: "0" }], error: null });
    expect((await rescoreAll()).remaining).toBe(0);
  });

  test("a failed BATCH query reports the error and stamps nothing", async () => {
    query.mockResolvedValue({ data: null, error: { message: "boom" } } as never);
    const res = await rescoreAll();
    expect(res.error).toContain("boom");
    // Feeding that result straight back through the guard must refuse.
    expect((await markCompScoringRescored(res)).stamped).toBe(false);
  });
});

describe("the save and reset paths report a write that failed", () => {
  // The four untreated siblings of saveCompFloor. Each swallowed an
  // empty-message failure and returned {}, which Settings.tsx's run() renders
  // as "Saved." before calling refresh(), whose syncSection then replaces the
  // user's typed draft with the re-read value. There is no history table.
  //
  // The amplification is what makes these worth their own tests rather than a
  // shared one: a swallowed failure does not just misreport, it falls through
  // to applySideEffects, which clears the paid-for search caches and stamps
  // criteria_changed_at for an edit that never landed.

  test("saveCriteriaList: a write with NO message is a failure, not a save", async () => {
    writeKey.mockResolvedValue({ error: "" });
    const res = await saveCriteriaList(SETTING_KEYS.titles, "Target titles", ["RevOps Lead"]);
    expect(res.error).toBeDefined();
    expect(res.error).not.toMatch(/—\s*$/);
  });

  test("saveCriteriaList: a failed write does NOT run the side effects", async () => {
    // The load-bearing half. applySideEffects deletes discovered_roles /
    // role_searches (re-billing the next search) and stamps
    // criteria_changed_at (suppressing stale-posting closure for ~2 crawl
    // cycles per company). Doing that for a save that never landed is worse
    // than the wrong banner.
    writeKey.mockResolvedValue({ error: "" });
    query.mockClear();
    await saveCriteriaList(SETTING_KEYS.titles, "Target titles", ["RevOps Lead"]);
    expect(query).not.toHaveBeenCalled();
  });

  test("saveCriteriaList: a clean write DOES run the side effects", async () => {
    // Both sides of the branch — without this, "never run side effects"
    // passes. titles is a crawl-relevant key, so this clears caches and stamps.
    writeKey.mockResolvedValue({});
    query.mockClear();
    const res = await saveCriteriaList(SETTING_KEYS.titles, "Target titles", ["RevOps Lead"]);
    expect(res).toEqual({});
    expect(query.mock.calls.length).toBeGreaterThan(0);
  });

  test("saveCriteriaText: an empty-message failure does not report success", async () => {
    // The fit brain travels this path — the costliest of the four, because
    // syncSection wipes the textarea on a reported success.
    writeKey.mockResolvedValue({ error: "" });
    const res = await saveCriteriaText(SETTING_KEYS.fitBrain, "Fit brain", "score harshly");
    expect(res.error).toBeDefined();
    expect(res.error).not.toMatch(/—\s*$/);
  });

  test("saveCriteriaText: a described failure keeps the driver's own words", async () => {
    writeKey.mockResolvedValue({ error: "read-only transaction" });
    const res = await saveCriteriaText(SETTING_KEYS.fitBrain, "Fit brain", "score harshly");
    expect(res.error).toContain("read-only transaction");
  });

  test("saveCeiling: an empty-message failure on the write path is reported", async () => {
    writeKey.mockResolvedValue({ error: "" });
    const res = await saveCeiling(12);
    expect(writeKey).toHaveBeenCalledWith(SETTING_KEYS.searchCeiling, 12);
    expect(res.error).toBeDefined();
  });

  test("saveCeiling: an empty-message failure on the DELETE path is reported", async () => {
    // Turning the ceiling off is a separate call with the same hazard.
    deleteKey.mockResolvedValue({ error: "" });
    const res = await saveCeiling(null);
    expect(deleteKey).toHaveBeenCalledWith(SETTING_KEYS.searchCeiling);
    expect(res.error).toBeDefined();
  });

  test("resetSetting: an empty-message delete failure is reported", async () => {
    deleteKey.mockResolvedValue({ error: "" });
    const res = await resetSetting(SETTING_KEYS.fitBrain);
    expect(res.error).toBeDefined();
    expect(res.error).not.toMatch(/—\s*$/);
  });

  test("resetSetting: a failed delete does NOT run the side effects", async () => {
    // A reset changes the effective criteria exactly as much as a save does,
    // so it stamps and clears caches too — and must not when the row survived.
    deleteKey.mockResolvedValue({ error: "" });
    query.mockClear();
    await resetSetting(SETTING_KEYS.titles);
    expect(query).not.toHaveBeenCalled();
  });

  test("resetSetting: a clean delete DOES run the side effects", async () => {
    deleteKey.mockResolvedValue({});
    query.mockClear();
    expect(await resetSetting(SETTING_KEYS.titles)).toEqual({});
    expect(query.mock.calls.length).toBeGreaterThan(0);
  });
});
