import { describe, expect, test } from "vitest";
import { DEFAULT_RESCORE_LIMIT, passStartFrom } from "./rescore-scope";
import {
  DOLLARS_PER_RESCORE,
  compRescoreOffer,
  fitBrainRescoreOffer,
  maxRescoreBatches,
  passDrained,
  rescoreCostDollars,
  rescoreOffers,
  rescorePromptQuestion,
  rescoreSummary,
  runRescorePass,
  shouldContinueRescore,
  type CompRescoreOfferInput,
  type FitBrainRescoreOfferInput,
  type RescoreBatchResult,
  type RescoreOfferSession,
  type RescoreOfferView,
} from "./rescore-progress";

describe("rescoreCostDollars", () => {
  test("pins the per-row rate", () => {
    // The number the prompt quotes to the user before they spend money. A
    // units slip here (0.075, 0.00075) passes every proportionality test.
    expect(DOLLARS_PER_RESCORE).toBe(0.0075);
  });

  test("multiplies the row count by the per-row rate", () => {
    expect(rescoreCostDollars(100)).toBe(0.75);
  });

  test("rounds to whole cents", () => {
    // 44 * 0.0075 = 0.33 exactly in decimal, but 0.33000000000000007 in
    // floating point — unrounded this renders as a long tail.
    expect(rescoreCostDollars(44)).toBe(0.33);
    expect(rescoreCostDollars(7)).toBe(0.05); // 0.0525 rounds up
  });

  test("rounds rather than truncates", () => {
    // 0.0525 -> 0.05 above and 0.0575 -> 0.06 here. Math.floor would give
    // 0.05 for both, understating what the user is about to spend.
    expect(rescoreCostDollars(9)).toBe(0.07); // 0.0675
  });

  test("is zero for zero, negative, and non-finite counts", () => {
    expect(rescoreCostDollars(0)).toBe(0);
    expect(rescoreCostDollars(-5)).toBe(0);
    expect(rescoreCostDollars(Number.NaN)).toBe(0);
  });
});

describe("shouldContinueRescore", () => {
  test("continues while there is work left and the last batch made progress", () => {
    expect(shouldContinueRescore({ rescored: 25, remaining: 60 })).toBe(true);
  });

  test("stops when nothing is left", () => {
    expect(shouldContinueRescore({ rescored: 25, remaining: 0 })).toBe(false);
  });

  test("stops when a batch made no progress, even with rows remaining", () => {
    // The whole reason this function exists. A permanently failing row keeps
    // `remaining` above zero forever; looping on `remaining > 0` alone spends
    // a Claude call per row per pass until something times out.
    expect(shouldContinueRescore({ rescored: 0, remaining: 60 })).toBe(false);
  });

  test("stops when both are zero", () => {
    expect(shouldContinueRescore({ rescored: 0, remaining: 0 })).toBe(false);
  });
});

describe("maxRescoreBatches", () => {
  test("covers the row count with one batch of slack", () => {
    expect(maxRescoreBatches(100, 25)).toBe(5);
  });

  test("rounds a partial batch up", () => {
    expect(maxRescoreBatches(26, 25)).toBe(3);
    expect(maxRescoreBatches(1, 25)).toBe(2);
  });

  test("never returns less than one, so a rescore always runs once", () => {
    expect(maxRescoreBatches(0)).toBe(1);
    expect(maxRescoreBatches(-10)).toBe(1);
    expect(maxRescoreBatches(Number.NaN)).toBe(1);
  });

  test("defaults to the action's own batch size", () => {
    expect(maxRescoreBatches(100)).toBe(maxRescoreBatches(100, DEFAULT_RESCORE_LIMIT));
  });
});

/**
 * A stand-in for the rescore action and the rows it walks, faithful to the
 * three behaviors the pass depends on:
 *
 *  - the batch is `limit` scored rows, OLDEST `updated_at` first
 *    (SCORED_JOBS_SQL),
 *  - a successful row's `updated_at` is stamped to "now" (updateJob),
 *  - `remaining` counts rows whose `updated_at` predates the pass start
 *    (SCORED_JOBS_REMAINING_SQL),
 *
 * and to the action's own timestamp rule: whatever it is handed, resolved
 * through the production `passStartFrom`, falling back to the server clock.
 *
 * Rows and clock are real state, so a wasted re-score is countable: every
 * scoreFit the pass buys increments `scoreFitCalls`.
 */
function fakeRescoreServer(opts: {
  rows: number;
  /** Trailing rows that can never be scored — they keep their timestamp. */
  unscorable?: number;
  defaultLimit?: number;
}) {
  const defaultLimit = opts.defaultLimit ?? DEFAULT_RESCORE_LIMIT;
  const unscorable = opts.unscorable ?? 0;
  const rows = Array.from({ length: opts.rows }, (_, i) => ({
    updatedAt: 0,
    scorable: i < opts.rows - unscorable,
  }));
  // Well after the rows' timestamps, as a real server clock would be.
  let clock = 1_000_000;
  let scoreFitCalls = 0;
  const seen: { passStartedAt: string | undefined; limit: number | undefined }[] = [];
  const remainingSeen: number[] = [];

  async function runBatch(args: {
    passStartedAt?: string;
    limit?: number;
  }): Promise<RescoreBatchResult> {
    seen.push({ passStartedAt: args.passStartedAt, limit: args.limit });
    const startedAt = passStartFrom(args.passStartedAt, new Date((clock += 1_000)));
    const startedMs = Date.parse(startedAt);

    const batch = [...rows]
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(0, args.limit ?? defaultLimit);

    let rescored = 0;
    let failed = 0;
    for (const row of batch) {
      scoreFitCalls++;
      if (!row.scorable) {
        failed++;
        continue;
      }
      row.updatedAt = clock += 1_000;
      rescored++;
    }

    const remaining = rows.filter((r) => r.updatedAt < startedMs).length;
    remainingSeen.push(remaining);
    return { rescored, failed, remaining, passStartedAt: startedAt };
  }

  return {
    runBatch,
    seen,
    remainingSeen,
    scoreFitCalls: () => scoreFitCalls,
    untouched: () => rows.filter((r) => r.updatedAt === 0).length,
  };
}

describe("runRescorePass — the pass across batches", () => {
  test("26 rows: `remaining` reaches zero, and the pass costs 26 scoreFit calls", async () => {
    // THE regression. With the pass timestamp taken per BATCH instead of per
    // PASS, batch 2 counts the 25 rows batch 1 just finished as still
    // outstanding — they carry an `updated_at` older than batch 2's own start.
    // Observed on this exact simulation before the fix: 3 batches, 75 scoreFit
    // calls, and a final `remaining` of 1. No number of clicks reaches zero,
    // so the "pass finished" branch in the component never fires.
    const server = fakeRescoreServer({ rows: 26 });
    const pass = await runRescorePass({ total: 26, runBatch: server.runBatch });

    expect(pass.remaining).toBe(0);
    expect(pass.rescored).toBe(26);
    expect(pass.failed).toBe(0);
    expect(pass.error).toBeUndefined();
    expect(server.scoreFitCalls()).toBe(26);
    expect(server.untouched()).toBe(0);
  });

  test("`remaining` decreases strictly, batch after batch, and ends at zero", async () => {
    const server = fakeRescoreServer({ rows: 100 });
    const pass = await runRescorePass({ total: 100, runBatch: server.runBatch });

    const seq = server.remainingSeen;
    // Non-empty, or `every` below is vacuously true.
    expect(seq.length).toBeGreaterThan(1);
    expect(seq[seq.length - 1]).toBe(0);
    for (let i = 1; i < seq.length; i++) {
      expect(seq[i]).toBeLessThan(seq[i - 1]);
    }
    expect(seq).toEqual([75, 50, 25, 0]);
    expect(pass.rescored).toBe(100);
    expect(server.scoreFitCalls()).toBe(100);
  });

  test("every batch after the first is handed the FIRST batch's timestamp", async () => {
    // The mechanism, stated directly: one timestamp per pass, minted server
    // side (no browser clock enters the comparison) and threaded forward.
    const server = fakeRescoreServer({ rows: 60 });
    await runRescorePass({ total: 60, runBatch: server.runBatch });

    expect(server.seen.length).toBeGreaterThan(1);
    expect(server.seen[0].passStartedAt).toBeUndefined();
    const threaded = server.seen.slice(1).map((s) => s.passStartedAt);
    expect(threaded.length).toBeGreaterThan(0);
    expect(new Set(threaded).size).toBe(1);
    expect(typeof threaded[0]).toBe("string");
  });

  test("the tail batch asks only for the rows still outstanding", async () => {
    // 26 rows, 25 per batch: without this the second batch asks for 25 and
    // re-scores 24 finished rows at ~$0.0076 each, then REPORTS them as
    // rescores — 50 calls for 26 rows of work.
    const server = fakeRescoreServer({ rows: 26 });
    await runRescorePass({ total: 26, runBatch: server.runBatch });

    expect(server.seen.map((s) => s.limit)).toEqual([undefined, 1]);
  });

  test("a permanently unscorable row stops the pass instead of spinning on it", async () => {
    // `remaining > 0` alone is not a drain condition: the failing row keeps
    // its old timestamp and stays counted forever.
    const server = fakeRescoreServer({ rows: 30, unscorable: 1 });
    const pass = await runRescorePass({ total: 30, runBatch: server.runBatch });

    expect(pass.failed).toBeGreaterThan(0);
    expect(pass.remaining).toBe(1);
    expect(pass.rescored).toBe(29);
    // Bounded: it does not burn the whole batch budget re-trying the row.
    expect(pass.batches).toBeLessThanOrEqual(maxRescoreBatches(30));
  });

  test("a batch error stops the pass and keeps the work already paid for", async () => {
    let n = 0;
    const pass = await runRescorePass({
      total: 100,
      runBatch: async () => {
        n++;
        if (n === 2) return { rescored: 0, failed: 0, remaining: 75, error: "boom" };
        return { rescored: 25, failed: 0, remaining: 75, passStartedAt: "t" };
      },
    });

    expect(pass.error).toBe("boom");
    expect(pass.rescored).toBe(25);
    expect(pass.batches).toBe(2);
  });

  test("a rejected batch is captured, not thrown — partial counts survive", async () => {
    // A thrown rejection out of the loop would lose the count of work the user
    // has already been billed for.
    let n = 0;
    const pass = await runRescorePass({
      total: 100,
      runBatch: async () => {
        n++;
        if (n === 2) throw new Error("network died");
        return { rescored: 25, failed: 0, remaining: 75, passStartedAt: "t" };
      },
    });

    expect(pass.error).toBe("network died");
    expect(pass.rescored).toBe(25);
  });

  test("the batch budget bounds the pass even when nothing ever drains", async () => {
    // Belt and braces: a batch that always claims progress AND always claims
    // work left must still stop. This is the loop's only defense against an
    // arithmetic bug on the server side.
    let calls = 0;
    const pass = await runRescorePass({
      total: 100,
      runBatch: async () => {
        calls++;
        return { rescored: 25, failed: 0, remaining: 999, passStartedAt: "t" };
      },
    });

    expect(calls).toBe(maxRescoreBatches(100));
    expect(pass.batches).toBe(maxRescoreBatches(100));
  });

  test("reports progress after every batch, never only at the end", async () => {
    const server = fakeRescoreServer({ rows: 60 });
    const seen: number[] = [];
    await runRescorePass({
      total: 60,
      runBatch: server.runBatch,
      onProgress: (t) => seen.push(t.rescored),
    });
    expect(seen.length).toBeGreaterThan(1);
    expect(seen).toEqual([25, 50, 60]);
  });
});

describe("rescoreSummary", () => {
  test("a complete pass reports only what it did", () => {
    expect(rescoreSummary({ rescored: 12, failed: 0, remaining: 0 })).toBe(
      "Rescored 12 roles."
    );
  });

  test("a single role reads in the singular", () => {
    expect(rescoreSummary({ rescored: 1, failed: 0, remaining: 0 })).toBe(
      "Rescored 1 role."
    );
  });

  test("a partial pass is never presented as complete", () => {
    // The dishonesty this function exists to prevent: "Rescored 25 roles." is
    // the whole message a naive implementation returns here.
    const s = rescoreSummary({ rescored: 25, failed: 0, remaining: 60 });
    expect(s).toContain("60 still to do");
    expect(s).toContain("run Rescore again");
  });

  test("failures are named and separated from successes", () => {
    const s = rescoreSummary({ rescored: 20, failed: 5, remaining: 0 });
    expect(s).toContain("Rescored 20 roles");
    expect(s).toContain("5 could not be scored");
    expect(s).toContain("kept their old scores");
  });

  test("a batch that only failed does not claim any rescores", () => {
    const s = rescoreSummary({ rescored: 0, failed: 3, remaining: 3 });
    expect(s).toContain("No roles were rescored");
    expect(s).not.toContain("Rescored 0");
    expect(s).toContain("3 still to do");
  });

  test("nothing to do says so rather than reporting zeros", () => {
    expect(rescoreSummary({ rescored: 0, failed: 0, remaining: 0 })).toBe(
      "Nothing to rescore."
    );
  });
});

describe("compRescoreOffer", () => {
  // Day one, exactly as a deploy leaves it: roles already scored, no pass ever
  // run, nothing edited, nothing dismissed.
  const DAY_ONE: CompRescoreOfferInput = {
    scoredJobCount: 26,
    compScoringRescoredAt: null,
    floorEditedThisSession: false,
    dismissed: false,
  };

  test("fires on a bare page load, with no edit anywhere", () => {
    // THE case this whole task exists for. Shipping compensation into scoreFit
    // made every stored score stale on DEPLOY — there is no user edit to hang
    // the offer off, so a session-only rule would show it to nobody.
    expect(compRescoreOffer(DAY_ONE)).toBe("comp-scoring");
  });

  test("a completed pass suppresses it for good, across page loads", () => {
    // scoredJobCount is UNCHANGED by a successful pass — rescoring updates
    // scores, it does not remove them — so without the stamp the offer returns
    // immediately, and forever.
    expect(
      compRescoreOffer({
        ...DAY_ONE,
        compScoringRescoredAt: "2026-08-14T00:00:00.000Z",
      })
    ).toBeNull();
  });

  test("a floor edit re-opens the offer after a pass was already stamped", () => {
    // The session flag's only job: it WIDENS the server gate. A floor edit
    // makes scores stale again, stamp or no stamp.
    expect(
      compRescoreOffer({
        ...DAY_ONE,
        compScoringRescoredAt: "2026-08-14T00:00:00.000Z",
        floorEditedThisSession: true,
      })
    ).toBe("edit");
  });

  test("the session flag is never REQUIRED — it cannot bury the day-one case", () => {
    // Both spellings of the flag still show the offer while the stamp is null.
    expect(compRescoreOffer({ ...DAY_ONE, floorEditedThisSession: false })).not.toBeNull();
    expect(compRescoreOffer({ ...DAY_ONE, floorEditedThisSession: true })).not.toBeNull();
  });

  test("a fresh save wins the wording when both gates are open", () => {
    // The user who just clicked Save is owed "Saved."; the user who just
    // opened the page is not.
    expect(compRescoreOffer({ ...DAY_ONE, floorEditedThisSession: true })).toBe("edit");
  });

  test("dismissing hides it, whichever gate opened it", () => {
    expect(compRescoreOffer({ ...DAY_ONE, dismissed: true })).toBeNull();
    expect(
      compRescoreOffer({ ...DAY_ONE, floorEditedThisSession: true, dismissed: true })
    ).toBeNull();
  });

  test("nothing scored means no offer, stamp or no stamp", () => {
    // Otherwise a fresh database gets a prompt offering to spend $0.00 on zero
    // roles on its very first page load.
    expect(compRescoreOffer({ ...DAY_ONE, scoredJobCount: 0 })).toBeNull();
    expect(
      compRescoreOffer({ ...DAY_ONE, scoredJobCount: 0, floorEditedThisSession: true })
    ).toBeNull();
  });
});

/**
 * The only way to obtain a RescoreReason.
 *
 * RescoreReason is branded, so `rescorePromptQuestion("edit", n)` does not
 * compile — anywhere, this file included. Values come from the gate that
 * produces them, which is the point: it also pins that each gate hands the
 * copy the wording that gate is supposed to produce.
 */
function reasonFrom(
  view: Partial<RescoreOfferView>,
  session: Partial<RescoreOfferSession>,
  which: keyof ReturnType<typeof rescoreOffers>
) {
  const offers = rescoreOffers(
    {
      scoredJobCount: 26,
      fitBrainOverridden: false,
      compScoringRescoredAt: null,
      ...view,
    },
    {
      fitBrainEditedThisSession: false,
      floorEditedThisSession: false,
      dismissed: false,
      ...session,
    }
  );
  const value = offers[which];
  if (value === null) throw new Error(`no ${which} offer for this input`);
  return value;
}

// Lazy, not module-level constants. A mutant that closes one of these gates
// would otherwise throw during import and take the whole FILE down as "0
// tests" — still a failure, but one that names no rule and that a mutation
// harness reading per-test results can mistake for a survivor. Called inside
// each test, the same mutant fails one named assertion.
const COMP_SCORING = () => reasonFrom({}, {}, "compensation");
const EDIT = () => reasonFrom({}, { floorEditedThisSession: true }, "compensation");
const FIT_BRAIN = () => reasonFrom({ fitBrainOverridden: true }, {}, "fitBrain");

describe("rescorePromptQuestion", () => {
  test("the day-one wording claims nothing it cannot know", () => {
    const s = rescorePromptQuestion(COMP_SCORING(), 26);
    // Nothing was saved — this fires on a page load.
    expect(s).not.toContain("Saved.");
    // There is no version column, so no row can be said to predate anything.
    expect(s).not.toContain("this edit");
    expect(s).not.toMatch(/were scored before|predate/i);
    expect(s).toMatch(/may not reflect/i);
    expect(s).toMatch(/compensation/i);
    expect(s).toContain("26 roles");
  });

  test("the fit-brain wording does not claim a save either", () => {
    // The copy that shipped hardcoded "Saved." at this call site, so a bare
    // page load with a stored brain said a save had happened when none had.
    const s = rescorePromptQuestion(FIT_BRAIN(), 26);
    expect(s).not.toContain("Saved.");
    expect(s).not.toContain("this edit");
    // …and it is about the brain, not about compensation.
    expect(s).toMatch(/fit brain/i);
    expect(s).not.toMatch(/compensation/i);
    expect(s).toMatch(/may not reflect/i);
  });

  test("the three wordings are actually different from one another", () => {
    // Guards every "not.toContain" above: a single shared string would satisfy
    // most of them individually while making the reason prop decorative.
    const all = [
      rescorePromptQuestion(COMP_SCORING(), 26),
      rescorePromptQuestion(FIT_BRAIN(), 26),
      rescorePromptQuestion(EDIT(), 26),
    ];
    expect(new Set(all).size).toBe(3);
  });

  test("the edit wording still says a save happened", () => {
    const s = rescorePromptQuestion(EDIT(), 26);
    expect(s).toContain("Saved.");
    expect(s).toContain("this edit");
  });

  test("every wording quotes the figure the pass actually bills", () => {
    // The prompt takes no dollar prop, from any caller: the number comes from
    // rescoreCostDollars or it does not exist.
    for (const count of [1, 26, 400]) {
      const expected = `$${rescoreCostDollars(count).toFixed(2)}`;
      expect(rescorePromptQuestion(COMP_SCORING(), count)).toContain(expected);
      expect(rescorePromptQuestion(FIT_BRAIN(), count)).toContain(expected);
      expect(rescorePromptQuestion(EDIT(), count)).toContain(expected);
    }
    // Guards the loop above: a wrong `count` list would otherwise pass vacuously.
    expect(rescorePromptQuestion(COMP_SCORING(), 26)).toContain("$0.20");
  });

  test("one role reads in the singular, in every wording", () => {
    for (const why of [COMP_SCORING(), FIT_BRAIN()]) {
      const s = rescorePromptQuestion(why, 1);
      expect(s).toContain("1 role has a score");
      expect(s).not.toContain("1 roles");
      expect(s).toContain("Rescore it");
    }
    const edit = rescorePromptQuestion(EDIT(), 1);
    expect(edit).toContain("1 role carries");
    expect(edit).toContain("Rescore it");
  });

  test("more than one role reads in the plural", () => {
    expect(rescorePromptQuestion(COMP_SCORING(), 2)).toContain("2 roles have scores");
    expect(rescorePromptQuestion(COMP_SCORING(), 2)).toContain("Rescore them");
    expect(rescorePromptQuestion(FIT_BRAIN(), 2)).toContain("2 roles have scores");
    expect(rescorePromptQuestion(EDIT(), 2)).toContain("2 roles carry");
  });
});

describe("passDrained", () => {
  // The condition that authorizes a PERMANENT stamp. Everything below is a
  // way of getting it wrong that used to ship green.
  test("a clean pass with a known zero remainder is drained", () => {
    expect(passDrained({ rescored: 26, remaining: 0 })).toBe(true);
  });

  test("an UNCOUNTED remainder is not a zero remainder", () => {
    // THE defect. The action returned 0 when its count query failed, which is
    // indistinguishable from a drained pass: 100 stale rows, 25 rescored, one
    // blip, and the offer was retired with 75 rows still stale — the user
    // seeing only "Rescored 25 roles."
    expect(passDrained({ rescored: 25, remaining: null })).toBe(false);
  });

  test("rows still to do are not drained", () => {
    expect(passDrained({ rescored: 25, remaining: 75 })).toBe(false);
  });

  test("a pass that scored nothing is not drained", () => {
    // Otherwise a pass where every row failed would stamp: `remaining` can be
    // 0 with `rescored` 0 when there was nothing to do in the first place.
    expect(passDrained({ rescored: 0, remaining: 0 })).toBe(false);
  });

  test("an errored pass is never drained, however it counted", () => {
    expect(passDrained({ rescored: 26, remaining: 0, error: "boom" })).toBe(false);
    // Presence, not truthiness — an empty driver message is still a failure.
    expect(passDrained({ rescored: 26, remaining: 0, error: "" })).toBe(false);
  });
});

describe("an uncounted remainder through the whole pass", () => {
  test("shouldContinueRescore stops rather than looping on an unknown", () => {
    // Continuing on a number nobody can verify is how a client loop bills
    // indefinitely.
    expect(shouldContinueRescore({ rescored: 25, remaining: null })).toBe(false);
  });

  test("runRescorePass carries the unknown out rather than flattening it", () => {
    // If the pass reported 0 here, passDrained above could never protect
    // anything — the information would already be gone.
    const batch: RescoreBatchResult = {
      rescored: 25,
      failed: 0,
      remaining: null,
      passStartedAt: "2026-08-14T00:00:00.000Z",
    };
    return runRescorePass({ total: 100, runBatch: async () => batch }).then((pass) => {
      expect(pass.remaining).toBeNull();
      expect(pass.rescored).toBe(25);
      // One batch only: an unknown remainder stops the loop.
      expect(pass.batches).toBe(1);
      expect(passDrained(pass)).toBe(false);
    });
  });

  test("rescoreSummary says the remainder is unknown instead of implying none", () => {
    // "Rescored 25 roles." full stop was the entire visible symptom of the bug.
    const s = rescoreSummary({ rescored: 25, failed: 0, remaining: null });
    expect(s).toContain("Rescored 25 roles");
    expect(s).toMatch(/could not be counted/i);
    expect(s).toContain("run Rescore again");
    // …and a real zero still reads as complete, or the message means nothing.
    expect(rescoreSummary({ rescored: 25, failed: 0, remaining: 0 })).toBe(
      "Rescored 25 roles."
    );
  });
});

describe("fitBrainRescoreOffer", () => {
  const BARE_LOAD: FitBrainRescoreOfferInput = {
    scoredJobCount: 26,
    fitBrainOverridden: true,
    fitBrainEditedThisSession: false,
    dismissed: false,
  };

  test("a stored custom brain offers a rescore on a bare load, without claiming a save", () => {
    const why = fitBrainRescoreOffer(BARE_LOAD);
    expect(why).not.toBeNull();
    expect(rescorePromptQuestion(why!, 26)).not.toContain("Saved.");
    expect(rescorePromptQuestion(why!, 26)).toMatch(/fit brain/i);
  });

  test("an edit in this session is what earns the 'Saved.' wording", () => {
    const why = fitBrainRescoreOffer({ ...BARE_LOAD, fitBrainEditedThisSession: true });
    expect(why).not.toBeNull();
    expect(rescorePromptQuestion(why!, 26)).toContain("Saved.");
  });

  test("a reset still offers, though it deleted the row the server gate reads", () => {
    // Reverting to the shipped brain DELETES the app_settings row, so
    // fitBrainOverridden goes false. The session flag is the only thing left.
    expect(
      fitBrainRescoreOffer({
        ...BARE_LOAD,
        fitBrainOverridden: false,
        fitBrainEditedThisSession: true,
      })
    ).not.toBeNull();
  });

  test("the shipped brain, untouched, offers nothing", () => {
    expect(
      fitBrainRescoreOffer({ ...BARE_LOAD, fitBrainOverridden: false })
    ).toBeNull();
  });

  test("dismissal and an empty pipeline each suppress it", () => {
    expect(fitBrainRescoreOffer({ ...BARE_LOAD, dismissed: true })).toBeNull();
    expect(fitBrainRescoreOffer({ ...BARE_LOAD, scoredJobCount: 0 })).toBeNull();
  });
});

describe("rescoreOffers", () => {
  const VIEW: RescoreOfferView = {
    scoredJobCount: 26,
    fitBrainOverridden: false,
    compScoringRescoredAt: null,
  };
  const SESSION: RescoreOfferSession = {
    fitBrainEditedThisSession: false,
    floorEditedThisSession: false,
    dismissed: false,
  };

  test("day one offers the compensation rescore and nothing else", () => {
    const offers = rescoreOffers(VIEW, SESSION);
    expect(offers.compensation).not.toBeNull();
    expect(offers.fitBrain).toBeNull();
  });

  test("each section reads its own server flag, not the other's", () => {
    // Crossed wiring here would put the compensation copy in the fit-brain
    // section, or retire the day-one offer whenever a brain was saved.
    const brainOnly = rescoreOffers(
      { ...VIEW, fitBrainOverridden: true, compScoringRescoredAt: "2026-08-14T00:00:00.000Z" },
      SESSION
    );
    expect(brainOnly.fitBrain).not.toBeNull();
    expect(brainOnly.compensation).toBeNull();
  });

  test("each section reads its own session flag, not the other's", () => {
    const floorOnly = rescoreOffers(
      { ...VIEW, compScoringRescoredAt: "2026-08-14T00:00:00.000Z" },
      { ...SESSION, floorEditedThisSession: true }
    );
    expect(floorOnly.compensation).not.toBeNull();
    expect(floorOnly.fitBrain).toBeNull();
  });

  test("one dismissal covers both offers", () => {
    const offers = rescoreOffers(
      { ...VIEW, fitBrainOverridden: true },
      { ...SESSION, dismissed: true }
    );
    expect(offers.fitBrain).toBeNull();
    expect(offers.compensation).toBeNull();
  });

  test("the wordings the two sections get are the ones their gates decided", () => {
    const offers = rescoreOffers(
      { ...VIEW, fitBrainOverridden: true },
      { ...SESSION, floorEditedThisSession: true }
    );
    expect(rescorePromptQuestion(offers.fitBrain!, 26)).toMatch(/fit brain/i);
    expect(rescorePromptQuestion(offers.compensation!, 26)).toContain("Saved.");
  });
});
