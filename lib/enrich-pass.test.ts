import { describe, expect, test, vi } from "vitest";

import {
  MAX_ENRICH_BATCHES,
  enrichProgressLine,
  enrichStatRows,
  runEnrichPass,
} from "./enrich-pass";
import type { EnrichPassResult } from "./enrich-pass";
import type { EnrichReport } from "@/lib/enrich-scope";

const batch = (over: Partial<EnrichReport>): EnrichReport => ({
  enriched: 0,
  empty: 0,
  relinked: 0,
  unreadable: 0,
  failed: 0,
  blocked: [],
  remaining: 0,
  cursor: null,
  ...over,
});

// The same shape runRescorePass has, and for the same reason: a loop living in
// a React component is reachable from no test in this repo, and the decisions
// it makes — when to stop, what to keep when a batch fails — are exactly the
// ones that cost money when they are wrong.
describe("paging a backfill to the end", () => {
  test("totals accumulate across batches", async () => {
    const runBatch = vi
      .fn()
      .mockResolvedValueOnce(batch({ enriched: 2, remaining: 1, cursor: "b" }))
      .mockResolvedValueOnce(batch({ enriched: 1, empty: 1, remaining: 0, cursor: "c" }));

    const pass = await runEnrichPass({ runBatch });

    expect(pass.enriched).toBe(3);
    expect(pass.empty).toBe(1);
    expect(pass.batches).toBe(2);
  });

  test("each batch resumes from the cursor the last one returned", async () => {
    const runBatch = vi
      .fn()
      .mockResolvedValueOnce(batch({ enriched: 1, remaining: 1, cursor: "b" }))
      .mockResolvedValueOnce(batch({ enriched: 1, remaining: 0, cursor: "c" }));

    await runEnrichPass({ runBatch });

    expect(runBatch.mock.calls[0][0].cursor).toBeUndefined();
    expect(runBatch.mock.calls[1][0].cursor).toBe("b");
  });

  test("a drained pass stops rather than buying another batch", async () => {
    const runBatch = vi.fn().mockResolvedValue(batch({ enriched: 1, remaining: 0, cursor: "a" }));

    await runEnrichPass({ runBatch });

    expect(runBatch).toHaveBeenCalledTimes(1);
  });

  // Presence, not truthiness. A batch reporting `error: ""` — the unreachable
  // database — read as success would keep the loop paying for batch after
  // batch against a database that answers nothing.
  test("an empty error string still stops the pass, with the work so far kept", async () => {
    const runBatch = vi
      .fn()
      .mockResolvedValueOnce(batch({ enriched: 2, remaining: 5, cursor: "b" }))
      .mockResolvedValueOnce(batch({ error: "", remaining: 5, cursor: "c" }));

    const pass = await runEnrichPass({ runBatch });

    expect(runBatch).toHaveBeenCalledTimes(2);
    expect(pass.error).toBe("");
    expect(pass.enriched).toBe(2);
  });

  test("a batch that throws keeps the totals it had already earned", async () => {
    const runBatch = vi
      .fn()
      .mockResolvedValueOnce(batch({ enriched: 3, remaining: 9, cursor: "b" }))
      .mockRejectedValueOnce(new Error("network"));

    const pass = await runEnrichPass({ runBatch });

    expect(pass.enriched).toBe(3);
    expect(pass.error).toBe("network");
  });

  // A batch whose rows were all blocked returns no cursor. Without this the
  // loop would restart from the beginning and re-examine the same rows until
  // its batch budget ran out.
  test("a batch that decided nothing ends the pass", async () => {
    const runBatch = vi.fn().mockResolvedValue(batch({ remaining: 4, cursor: null }));

    const pass = await runEnrichPass({ runBatch });

    expect(runBatch).toHaveBeenCalledTimes(1);
    expect(pass.remaining).toBe(4);
  });

  test("no arithmetic bug can bill indefinitely", async () => {
    // Always claims work left and always returns a fresh cursor.
    let n = 0;
    const runBatch = vi.fn().mockImplementation(async () =>
      batch({ enriched: 1, remaining: 99, cursor: `c${n++}` })
    );

    const pass = await runEnrichPass({ runBatch });

    expect(pass.batches).toBe(MAX_ENRICH_BATCHES);
  });

  test("progress is reported after every batch, not only at the end", async () => {
    const onProgress = vi.fn();
    const runBatch = vi
      .fn()
      .mockResolvedValueOnce(batch({ enriched: 1, remaining: 1, cursor: "b" }))
      .mockResolvedValueOnce(batch({ enriched: 1, remaining: 0, cursor: "c" }));

    await runEnrichPass({ runBatch, onProgress });

    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress.mock.calls[0][0].enriched).toBe(1);
  });
});

const pass = (over: Partial<EnrichPassResult>): EnrichPassResult => ({
  enriched: 0,
  empty: 0,
  relinked: 0,
  unreadable: 0,
  failed: 0,
  blocked: [],
  remaining: 0,
  batches: 1,
  ...over,
});

// The banner shows COUNTS, not prose, and the mapping from totals to rows is
// out here for the reason fitBrainRescoreOffer's comment records: a table
// composed in JSX is a table no test can see. The first version buried five
// numbers in a sentence and then listed two dozen blocked rows under it, so
// the one thing the user needed — did this work, is it still going — was the
// hardest thing on screen to find.
describe("the results table", () => {
  const rows = (over: Partial<EnrichPassResult>) =>
    enrichStatRows(pass(over)).map((r) => [r.label, r.value] as const);

  test("what was stored is always shown, even when it is zero", () => {
    expect(rows({})).toContainEqual(["Stored", 0]);
  });

  test("a count of zero is otherwise left out rather than padding the table", () => {
    const labels = rows({ enriched: 3 }).map(([label]) => label);

    expect(labels).toEqual(["Stored"]);
  });

  test("every outcome that happened gets its own row", () => {
    const labels = rows({
      enriched: 4,
      empty: 1,
      relinked: 2,
      unreadable: 21,
      failed: 1,
      blocked: [{ id: "j1", company: "C", role_title: "R", url: "u", reason: "absent" }],
      remaining: 10,
    }).map(([label]) => label);

    expect(labels).toEqual([
      "Stored",
      "Nothing to store",
      "Links repaired",
      "Could not be read",
      "Failed",
      "Left alone",
      "Still to do",
    ]);
  });

  // The three that are not wins each carry why, because "21 could not be read"
  // with no cause reads as a bug rather than as client-rendered postings.
  test("the outcomes that are not wins explain themselves", () => {
    const table = enrichStatRows(
      pass({ unreadable: 21, blocked: [{ id: "j", company: "C", role_title: "R", url: "u", reason: "absent" }] })
    );

    expect(table.find((r) => r.label === "Could not be read")?.note).toBeTruthy();
    expect(table.find((r) => r.label === "Left alone")?.note).toBeTruthy();
  });
});

describe("the progress line while a pass is running", () => {
  test("it counts rows decided and rows left, so a long pass is visibly moving", () => {
    const line = enrichProgressLine(pass({ enriched: 2, unreadable: 5, blocked: [], remaining: 40 }));

    expect(line).toContain("7");
    expect(line).toContain("40");
  });

  test("blocked rows count as decided — they cost a lookup and will not be revisited", () => {
    const line = enrichProgressLine(
      pass({ blocked: [{ id: "j", company: "C", role_title: "R", url: "u", reason: "absent" }], remaining: 3 })
    );

    expect(line).toContain("1");
  });

  test("the first tick, before any batch has answered, says something rather than 0 of 0", () => {
    expect(enrichProgressLine(pass({}))).toContain("Starting");
  });
});
