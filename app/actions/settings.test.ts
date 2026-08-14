import { beforeEach, describe, expect, test, vi } from "vitest";

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
}));

import { markCompScoringRescored, rescoreAll } from "./settings";
import { SCORED_JOBS_REMAINING_SQL, SCORED_JOBS_SQL } from "@/lib/rescore-scope";
import { writeCompScoringRescoredAt } from "@/lib/settings-store";
import { rawQuery } from "@/lib/supabase";

const write = vi.mocked(writeCompScoringRescoredAt);
const query = vi.mocked(rawQuery);

/** A pass that drained cleanly — the ONLY shape allowed to stamp. */
const DRAINED = { rescored: 26, remaining: 0 };

beforeEach(() => {
  write.mockReset();
  write.mockResolvedValue({});
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
