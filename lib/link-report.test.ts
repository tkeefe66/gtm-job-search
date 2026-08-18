import { describe, expect, test } from "vitest";
import { splitUnclear, type UnclearReason } from "./link-report";

const row = (id: string, reason: UnclearReason) => ({ id, reason });

describe("splitUnclear", () => {
  // Mutation caught: either filter using the wrong literal — `empty` collecting
  // the ambiguous rows or vice versa. A fixture with only one reason in it
  // cannot tell a swapped pair from a correct one, so both are present here.
  test("sends each row to the group its reason names", () => {
    const res = splitUnclear([row("a", "ambiguous"), row("b", "empty"), row("c", "ambiguous")]);

    expect(res.ambiguous.map((r) => r.id)).toEqual(["a", "c"]);
    expect(res.empty.map((r) => r.id)).toEqual(["b"]);
  });

  // Mutation caught: a filter reordering its group (e.g. reversing, or sorting
  // by reason). The banner lists rows in the order the repair pass found them,
  // and a user comparing the list to a second run should see the same order.
  test("preserves the original order inside each group", () => {
    const res = splitUnclear([
      row("a", "empty"),
      row("b", "ambiguous"),
      row("c", "empty"),
      row("d", "empty"),
    ]);

    expect(res.empty.map((r) => r.id)).toEqual(["a", "c", "d"]);
    expect(res.ambiguous.map((r) => r.id)).toEqual(["b"]);
  });

  // Mutation caught: returning undefined rather than an empty array for a group
  // with no rows. The banner renders `group.length > 0`, which throws on
  // undefined instead of rendering nothing.
  test("a group with no rows is an empty array, not absent", () => {
    const res = splitUnclear([row("a", "empty")]);

    expect(res.ambiguous).toEqual([]);
    expect(res.unresolved).toEqual([]);
    expect(res.empty).toHaveLength(1);
  });

  test("no rows at all still returns every group", () => {
    expect(splitUnclear([])).toEqual({ ambiguous: [], empty: [], unresolved: [] });
  });

  // Mutation caught: `unresolved` rows falling into either closable group.
  // Those rows are NOT evidence a posting is gone — only that the link could
  // not be checked past — and the closable groups carry a "Move to Out" button.
  test("unresolved rows go to their own group, never a closable one", () => {
    const res = splitUnclear([row("a", "unresolved"), row("b", "empty"), row("c", "ambiguous")]);

    expect(res.unresolved.map((r) => r.id)).toEqual(["a"]);
    expect(res.empty.map((r) => r.id)).toEqual(["b"]);
    expect(res.ambiguous.map((r) => r.id)).toEqual(["c"]);
  });
});
