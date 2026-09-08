import { describe, expect, test, vi } from "vitest";

import { MAX_ENRICH_BATCHES, runEnrichPass, summarizeEnrich } from "./enrich-pass";
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

// The wording is out here for the reason fitBrainRescoreOffer's comment
// records: a sentence composed at the call site is a sentence no test can see.
describe("what the banner says", () => {
  test("a clean pass says what it stored", () => {
    expect(summarizeEnrich(pass({ enriched: 7 }))).toContain("7 roles");
  });

  test("one role is not '1 roles'", () => {
    expect(summarizeEnrich(pass({ enriched: 1 }))).toContain("1 role.");
  });

  // Counted apart from spend: a systematic extraction failure looks exactly
  // like a successful pass if these are folded into "enriched".
  test("rows whose posting said nothing usable are reported separately", () => {
    expect(summarizeEnrich(pass({ enriched: 2, empty: 3 }))).toContain("3");
  });

  test("rows that could not be read are named as skipped, not failed", () => {
    const text = summarizeEnrich(pass({ unreadable: 4 }));

    expect(text).toContain("4");
    expect(text.toLowerCase()).toContain("could not be read");
  });

  test("a pass that found nothing to do says so rather than reading as an error", () => {
    expect(summarizeEnrich(pass({}))).toContain("Nothing to read");
  });

  test("work left over is stated, so a stopped pass is not mistaken for a finished one", () => {
    expect(summarizeEnrich(pass({ enriched: 10, remaining: 12 }))).toContain("12 still");
  });
});
