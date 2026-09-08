import { describe, expect, test } from "vitest";

import { boardRecall, BOARD_RECHECK_DAYS, type StoredBoard } from "./board-store";

const at = (daysAgo: number) =>
  new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();

// Resolution costs no tokens but real TIME — a company that resolves to nothing
// is up to slugs × vendors sequential fetches at an 8s timeout, on top of a
// measured 91.2s crawl, inside a request Railway closes after 300s. Remembering
// the answer, including "none", is what keeps that bounded.
describe("what a remembered board lets a crawl skip", () => {
  const found: StoredBoard = {
    vendor: "greenhouse",
    slug: "anthropic",
    source: "read",
    checkedAt: at(1),
  };

  test("a fresh resolution is used as-is", () => {
    expect(boardRecall(found)).toEqual({ kind: "use", board: found });
  });

  // The remembered FAILURE is the whole point: without it every crawl re-pays
  // the full vendor sweep for a company that has no board.
  test("a fresh 'no board' answer is honoured, not re-probed", () => {
    expect(boardRecall({ vendor: null, slug: null, source: null, checkedAt: at(1) })).toEqual({
      kind: "skip",
    });
  });

  // Companies move ATS, and a board that stops resolving is a signal in its own
  // right — so nothing is remembered forever.
  test("a stale answer is re-resolved, found or not", () => {
    expect(boardRecall({ ...found, checkedAt: at(BOARD_RECHECK_DAYS + 1) }).kind).toBe("resolve");
    expect(
      boardRecall({ vendor: null, slug: null, source: null, checkedAt: at(BOARD_RECHECK_DAYS + 1) })
        .kind
    ).toBe("resolve");
  });

  test("nothing remembered means resolve", () => {
    expect(boardRecall(null).kind).toBe("resolve");
  });

  // An unparseable timestamp must send the crawl down the RESOLVE path, not the
  // skip path: the cost of re-resolving is seconds, the cost of skipping
  // forever on a bad value is a company that silently never uses its board.
  test("an unreadable timestamp is treated as stale", () => {
    expect(boardRecall({ ...found, checkedAt: "whenever" }).kind).toBe("resolve");
  });

  // A row written before `source` existed cannot be trusted to source roles,
  // because the read/guessed distinction is the entire safety story.
  test("a remembered board with no recorded provenance is re-resolved", () => {
    expect(boardRecall({ ...found, source: null }).kind).toBe("resolve");
  });
});
