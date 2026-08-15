import { describe, expect, test } from "vitest";
import { UNDESCRIBED_DB_ERROR } from "./write-failure";
import { selectionInView, summarizeBulkStatus } from "./bulk-status";

const rows = (...ids: string[]) => ids.map((id) => ({ id }));

describe("selectionInView", () => {
  test("keeps only the selected rows that are on screen, in display order", () => {
    const visible = rows("c", "a", "b");
    expect(selectionInView(visible, new Set(["a", "b"]))).toEqual(rows("a", "b"));
  });

  test("drops a selected row the filter has hidden", () => {
    // The whole point: tick 3, narrow the search, and the two that vanished
    // must not be written to. A stale id in the Set is expected, not a bug.
    expect(selectionInView(rows("a"), new Set(["a", "gone", "also-gone"]))).toEqual(rows("a"));
  });

  test("an empty selection selects nothing", () => {
    expect(selectionInView(rows("a", "b"), new Set())).toEqual([]);
  });
});

describe("summarizeBulkStatus", () => {
  test("every write saved reports nothing", () => {
    expect(summarizeBulkStatus([{ id: "a" }, { id: "b" }], "Passed")).toBeNull();
  });

  test("names the failed ids so the caller can roll them back", () => {
    const out = summarizeBulkStatus(
      [{ id: "a" }, { id: "b", error: "boom" }, { id: "c", error: "boom" }],
      "Passed"
    );
    expect(out?.failedIds).toEqual(["b", "c"]);
  });

  test("a partial failure says how many of how many landed", () => {
    const out = summarizeBulkStatus(
      [{ id: "a" }, { id: "b" }, { id: "c", error: "duplicate key" }],
      "Not Interested"
    );
    expect(out?.message).toBe(
      'Moved 2 of 3 roles to "Not Interested", but 1 could not be saved — duplicate key'
    );
  });

  test("a total failure does not claim anything landed", () => {
    const out = summarizeBulkStatus(
      [{ id: "a", error: "down" }, { id: "b", error: "down" }],
      "Rejected"
    );
    expect(out?.message).toBe('Could not move 2 roles to "Rejected" — down');
  });

  test("one failed role reads as a role, not roles", () => {
    const out = summarizeBulkStatus([{ id: "a", error: "down" }], "Passed");
    expect(out?.message).toBe('Could not move 1 role to "Passed" — down');
  });

  test("an EMPTY error message is a failure, not a success", () => {
    // Presence, not truthiness. `pg` rejects with an AggregateError whose
    // message is "" whenever every address of a dual-stack host refuses, which
    // is exactly what an unreachable DATABASE_URL produces. Reading that as a
    // save is the defect this whole doctrine exists to prevent.
    const out = summarizeBulkStatus([{ id: "a" }, { id: "b", error: "" }], "Passed");
    expect(out).not.toBeNull();
    expect(out?.failedIds).toEqual(["b"]);
    expect(out?.message).toBe(
      `Moved 1 of 2 roles to "Passed", but 1 could not be saved — ${UNDESCRIBED_DB_ERROR}`
    );
  });

  test("reports the first reason when the failures disagree", () => {
    const out = summarizeBulkStatus(
      [{ id: "a", error: "first" }, { id: "b", error: "second" }],
      "Passed"
    );
    expect(out?.message).toContain("first");
    expect(out?.message).not.toContain("second");
  });

  test("an empty batch reports nothing", () => {
    expect(summarizeBulkStatus([], "Passed")).toBeNull();
  });
});
