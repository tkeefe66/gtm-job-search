import { afterEach, describe, expect, it, vi } from "vitest";
import type { CrawlOutcome } from "./crawler";
import type { TrackedCompany } from "./types";
import { createWatchlistCheckLock, runWatchlistChecks, watchlistCheckCandidates, type WatchlistBatchProgress } from "./watchlist-batch";

const NOW = new Date("2026-09-28T17:30:00Z");

function tracked(company: string, changes: Partial<TrackedCompany> = {}): TrackedCompany {
  return {
    id: company, company, tagline: null, raised: null, stage: null,
    lead_investor: null, founded: null, traction: null, careers_url: null,
    category: null, headquarters: null, added_at: "2026-09-01T00:00:00Z",
    last_checked_at: "2026-09-28T17:00:00Z", tracking_enabled: true,
    crawl_method: "fetch", crawl_interval_days: 7, last_crawl_status: "ok",
    last_crawl_error: null, consecutive_failures: 0, failing_since: null,
    source: "manual", signal: null, extras: {}, ...changes,
  };
}

function outcome(company: string, status: CrawlOutcome["status"] = "ok"): CrawlOutcome {
  return { company, method: "fetch", rolesFound: 1, newRoles: 1, status };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}

afterEach(() => vi.useRealTimers());

describe("createWatchlistCheckLock", () => {
  // Mutation: rely on asynchronous React state and allow a second click to start another request.
  it("refuses a rapid duplicate start while a confirmed check is running", () => {
    const lock = createWatchlistCheckLock();
    expect(lock.tryStart()).toBe(true);
    expect(lock.tryStart()).toBe(false);
    expect(lock.isUnconfirmed()).toBe(false);
  });

  // Mutation: retain the busy flag after a confirmed request finishes, permanently blocking future checks.
  it("allows a new check after releasing a confirmed request", () => {
    const lock = createWatchlistCheckLock();
    expect(lock.tryStart()).toBe(true);
    expect(lock.tryStart()).toBe(false);
    lock.release();
    expect(lock.tryStart()).toBe(true);
    expect(lock.tryStart()).toBe(false);
  });

  // Mutation: clear the unknown-server-outcome latch in finally/release, allowing manual or batch retries.
  it("keeps both individual and batch restarts blocked after an unconfirmed request is released", () => {
    const lock = createWatchlistCheckLock();
    expect(lock.tryStart()).toBe(true);
    lock.markUnconfirmed();
    lock.release();
    expect(lock.isUnconfirmed()).toBe(true);
    expect(lock.tryStart()).toBe(false);
    lock.release();
    expect(lock.tryStart()).toBe(false);
    expect(lock.isUnconfirmed()).toBe(true);
  });

  // Mutation: use module-global flags so an unconfirmed request blocks every independent mount.
  it("keeps the unconfirmed latch local to its own instance", () => {
    const oldMount = createWatchlistCheckLock();
    oldMount.markUnconfirmed();
    oldMount.release();
    expect(oldMount.tryStart()).toBe(false);
    const newMount = createWatchlistCheckLock();
    expect(newMount.isUnconfirmed()).toBe(false);
    expect(newMount.tryStart()).toBe(true);
    expect(oldMount.isUnconfirmed()).toBe(true);
  });
});

describe("watchlistCheckCandidates", () => {
  // Mutation: select only due rows, losing unfinished checks whose next attempt is in the future.
  it("includes every needs-attention state even before its scheduled check", () => {
    const rows = [
      tracked("Partial", { last_crawl_status: "partial" }),
      tracked("Deferred", { last_crawl_status: "skipped" }),
      tracked("Error", { last_crawl_status: "error" }),
      tracked("Needs URL", { last_crawl_status: "needs_url" }),
      tracked("Failing", { consecutive_failures: 3 }),
      tracked("Only two failures", { consecutive_failures: 2 }),
      tracked("Healthy"),
      tracked("Empty", { last_crawl_status: "empty" }),
      tracked("Unchanged", { last_crawl_status: "unchanged" }),
    ];
    expect(watchlistCheckCandidates(rows, NOW)).toEqual(["Partial", "Deferred", "Error", "Needs URL", "Failing"]);
  });

  // Mutation: use rowState === due, or ignore next_attempt_at, instead of actual scheduling eligibility.
  it("includes exactly due and never-checked rows and respects an explicit next attempt", () => {
    expect(watchlistCheckCandidates([
      tracked("At boundary", { next_attempt_at: NOW.toISOString() }),
      tracked("After boundary", { next_attempt_at: "2026-09-28T17:30:00.001Z" }),
      tracked("Never checked", { last_checked_at: null }),
      tracked("Old empty", { last_checked_at: "2026-09-21T17:30:00Z", last_crawl_status: "empty" }),
      tracked("Old unchanged", { last_checked_at: "2026-09-20T00:00:00Z", last_crawl_status: "unchanged" }),
      tracked("Explicit future", { last_checked_at: null, next_attempt_at: "2026-09-29T00:00:00Z" }),
    ], NOW)).toEqual(["At boundary", "Never checked", "Old empty", "Old unchanged"]);
  });

  // Mutation: calculate eligibility from last successful check instead of the latest attempt.
  it("uses the latest attempt with the legacy check timestamp as fallback", () => {
    expect(watchlistCheckCandidates([
      tracked("Recent attempt", { last_attempted_at: "2026-09-28T00:00:00Z", last_checked_at: "2026-09-01T00:00:00Z" }),
      tracked("Legacy due", { last_attempted_at: null, last_checked_at: "2026-09-01T00:00:00Z" }),
    ], NOW)).toEqual(["Legacy due"]);
  });

  // Mutation: omit the tracking gate so due dates or failures reactivate untracked companies.
  it("excludes untracked rows regardless of their failures and due dates", () => {
    expect(watchlistCheckCandidates([
      tracked("Disabled partial", { tracking_enabled: false, last_crawl_status: "partial", last_checked_at: null }),
      tracked("Disabled failing", { tracking_enabled: false, consecutive_failures: 9, last_checked_at: null }),
      tracked("Active", { last_checked_at: null }),
    ], NOW)).toEqual(["Active"]);
  });

  // Mutation: preserve duplicate eligible names or sort the queue rather than preserving watchlist order.
  it("selects each eligible name once in original order", () => {
    expect(watchlistCheckCandidates([
      tracked("Zulu", { last_checked_at: null }),
      tracked("Alpha", { last_crawl_status: "partial" }),
      tracked("Zulu", { last_crawl_status: "error" }),
    ], NOW)).toEqual(["Zulu", "Alpha"]);
  });
});

describe("runWatchlistChecks", () => {
  // Mutation: dispatch concurrently or use the deep-search trigger instead of an explicit direct check.
  it("waits for each direct check and emits progress before and after its confirmed result", async () => {
    const first = deferred<CrawlOutcome>();
    const started: string[] = [];
    const progress: WatchlistBatchProgress[] = [];
    const run = runWatchlistChecks(["First", "Second"], {
      check: (company, trigger) => {
        started.push(`${company}:${trigger}`);
        return company === "First" ? first.promise : Promise.resolve(outcome(company));
      },
      shouldStop: () => false,
      onProgress: (p) => progress.push(p),
    });
    expect(started).toEqual(["First:check"]);
    expect(progress[0]).toMatchObject({ total: 2, completed: 0, currentCompany: "First", results: [] });
    first.resolve(outcome("First"));
    const final = await run;
    expect(started).toEqual(["First:check", "Second:check"]);
    expect(progress.some((p) => p.completed === 1 && p.currentCompany === null)).toBe(true);
    expect(progress.some((p) => p.completed === 1 && p.currentCompany === "Second")).toBe(true);
    expect(final).toMatchObject({ total: 2, completed: 2, currentCompany: null, stopped: false, interrupted: false });
    expect(final.results.map((r) => r.company)).toEqual(["First", "Second"]);
    expect(progress[0].results).toEqual([]);
  });

  // Mutation: reread the caller's array, retain duplicates, or automatically retry a partial result.
  it("runs a fixed unique queue once even when a result remains partial", async () => {
    const queue = ["First", "First", "Second"];
    const started: string[] = [];
    const final = await runWatchlistChecks(queue, {
      check: async (company) => {
        started.push(company);
        queue.push("Added while running");
        return outcome(company, "partial");
      },
      shouldStop: () => false,
      onProgress: () => {},
    });
    expect(started).toEqual(["First", "Second"]);
    expect(final.total).toBe(2);
    expect(final.completed).toBe(2);
    expect(final.results.map((r) => r.outcome?.status)).toEqual(["partial", "partial"]);
  });

  // Mutation: ignore a stop request while an in-flight request is settling, starting another company.
  it("lets the current request finish but stops before the next company", async () => {
    const first = deferred<CrawlOutcome>();
    let stop = false;
    const started: string[] = [];
    const run = runWatchlistChecks(["First", "Second"], {
      check: (company) => { started.push(company); return first.promise; },
      shouldStop: () => stop,
      onProgress: () => {},
    });
    stop = true;
    first.resolve(outcome("First"));
    const final = await run;
    expect(started).toEqual(["First"]);
    expect(final).toMatchObject({ total: 2, completed: 1, currentCompany: null, stopped: true, interrupted: false });
  });

  // Mutation: ignore an already-set stop flag and make the first request.
  it("can stop before any request begins", async () => {
    let calls = 0;
    const final = await runWatchlistChecks(["First"], {
      check: async (company) => { calls += 1; return outcome(company); },
      shouldStop: () => true,
      onProgress: () => {},
    });
    expect(calls).toBe(0);
    expect(final).toMatchObject({ total: 1, completed: 0, stopped: true, interrupted: false, currentCompany: null, results: [] });
  });

  // Mutation: mark a fully finished batch stopped merely because the stop flag was later raised.
  it("does not call a completed batch stopped when no companies remain", async () => {
    let stop = false;
    const final = await runWatchlistChecks(["Only"], {
      check: async (company) => { stop = true; return outcome(company); },
      shouldStop: () => stop,
      onProgress: () => {},
    });
    expect(final).toMatchObject({ total: 1, completed: 1, stopped: false, interrupted: false });
  });

  // Mutation: continue after a rejected RPC, retry it, or count its unknown outcome as completed.
  it("halts on an unknown server outcome without losing earlier confirmed results", async () => {
    const started: string[] = [];
    const final = await runWatchlistChecks(["Confirmed", "Lost", "Unstarted"], {
      check: async (company) => {
        started.push(company);
        if (company === "Lost") throw new Error("Connection lost");
        return outcome(company);
      },
      shouldStop: () => false,
      onProgress: () => {},
    });
    expect(started).toEqual(["Confirmed", "Lost"]);
    expect(final).toMatchObject({ total: 3, completed: 1, interrupted: true, stopped: false, currentCompany: null });
    expect(final.results).toHaveLength(2);
    expect(final.results[1].outcome).toBeUndefined();
    expect(final.results[1].error).toContain("Connection lost");
    expect(final.results[1].error).toMatch(/may still finish/i);
  });

  // Mutation: render an empty failure string or treat it as a successful completion.
  it("gives a useful interruption explanation for an empty rejected error", async () => {
    const final = await runWatchlistChecks(["Lost"], {
      check: async () => { throw new Error(""); },
      shouldStop: () => false,
      onProgress: () => {},
    });
    expect(final).toMatchObject({ completed: 0, interrupted: true });
    expect(final.results[0].error).toMatch(/could not confirm/i);
    expect(final.results[0].error).toMatch(/refresh/i);
  });

  // Mutation: omit requestWithDeadline and leave the batch stuck forever on a hung RPC.
  it("interrupts at the existing deadline without retrying or cancelling server work", async () => {
    vi.useFakeTimers();
    const first = deferred<CrawlOutcome>();
    const started: string[] = [];
    const run = runWatchlistChecks(["Slow", "Unstarted"], {
      check: (company) => { started.push(company); return first.promise; },
      shouldStop: () => false,
      onProgress: () => {},
    });
    await vi.advanceTimersByTimeAsync(299_999);
    expect(started).toEqual(["Slow"]);
    await vi.advanceTimersByTimeAsync(1);
    const final = await run;
    expect(final).toMatchObject({ completed: 0, interrupted: true, stopped: false, currentCompany: null });
    expect(final.results[0].error).toMatch(/timed out/i);
    first.resolve(outcome("Slow"));
    await first.promise;
    expect(started).toEqual(["Slow"]);
    expect(final.completed).toBe(0);
  });

  // Mutation: halt on a confirmed error status instead of distinguishing it from an unknown RPC result.
  it("continues after a confirmed server error while preserving the outcome", async () => {
    const final = await runWatchlistChecks(["Failed", "Healthy"], {
      check: async (company) => company === "Failed" ? { ...outcome(company, "error"), error: "" } : outcome(company),
      shouldStop: () => false,
      onProgress: () => {},
    });
    expect(final).toMatchObject({ completed: 2, interrupted: false });
    expect(final.results[0].outcome).toMatchObject({ status: "error", error: "" });
    expect(final.results[1].company).toBe("Healthy");
  });

  // Mutation: let a rendering callback exception enter the check catch and reclassify or repeat server work.
  it("does not lose or repeat checks when progress reporting throws", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const started: string[] = [];
    try {
      const final = await runWatchlistChecks(["First", "Second"], {
        check: async (company) => { started.push(company); return outcome(company); },
        shouldStop: () => false,
        onProgress: () => { throw new Error("UI callback failed"); },
      });
      expect(started).toEqual(["First", "Second"]);
      expect(final).toMatchObject({ completed: 2, interrupted: false });
    } finally { logged.mockRestore(); }
  });

  // Mutation: mark an empty queue stopped or invoke a check even though no company is eligible.
  it("returns and publishes a finished empty batch without making requests", async () => {
    let calls = 0;
    const progress: WatchlistBatchProgress[] = [];
    const final = await runWatchlistChecks([], {
      check: async (company) => { calls += 1; return outcome(company); },
      shouldStop: () => true,
      onProgress: (p) => progress.push(p),
    });
    expect(calls).toBe(0);
    expect(final).toEqual({ total: 0, completed: 0, currentCompany: null, results: [], stopped: false, interrupted: false });
    expect(progress[progress.length - 1]).toEqual(final);
  });
});
