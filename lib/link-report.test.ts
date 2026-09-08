import { describe, expect, test } from "vitest";
import { splitUnclear, type UnclearReason, remainingUnclear } from "./link-report";

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
    expect(splitUnclear([])).toEqual({
      ambiguous: [],
      empty: [],
      unresolved: [],
      likelyClosed: [],
    });
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

// The defect this exists for, seen in production 2026-09-07: clicking "Move all
// 6 to Out" emptied the whole report, taking three rows the user had not
// touched with it. The rule was written in the component as
// `unclear.filter((r) => failedIds.has(r.id))` — keep only what FAILED — which
// is right for the rows that were acted on and wrong for every other row in the
// report. Out here it is a rule with a test instead of an expression nothing
// can see.
describe("what stays in the report after a bulk move", () => {
  const rows = [
    { id: "a", reason: "empty" as const },
    { id: "b", reason: "empty" as const },
    { id: "c", reason: "unresolved" as const },
  ];

  test("rows that were never acted on stay, whatever happened to the others", () => {
    const left = remainingUnclear(rows, ["a", "b"], []);

    expect(left.map((r) => r.id)).toEqual(["c"]);
  });

  test("a row that was acted on and saved is gone — a second click would rewrite it", () => {
    expect(remainingUnclear(rows, ["a"], []).map((r) => r.id)).toEqual(["b", "c"]);
  });

  test("a row that was acted on and FAILED stays, so the retry is one click", () => {
    expect(remainingUnclear(rows, ["a", "b"], ["b"]).map((r) => r.id)).toEqual(["b", "c"]);
  });

  test("acting on nothing changes nothing", () => {
    expect(remainingUnclear(rows, [], []).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  test("order is preserved, so the list does not reshuffle under the cursor", () => {
    expect(remainingUnclear(rows, ["b"], ["b"]).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
})

// A fourth reason, from a real case on 2026-09-07: eleven openai.com rows whose
// employer site answers 403 to any automated reader, and whose board — found by
// GUESSING a slug — no longer lists the titles. The user checked ten by hand
// and every one redirected to the general careers page. The app had both
// signals and said nothing.
describe("likely-closed rows are grouped like every other reason", () => {
  test("the new reason gets its own group", () => {
    const rows = [
      { id: "a", reason: "likely-closed" as const },
      { id: "b", reason: "unresolved" as const },
    ];

    expect(splitUnclear(rows).likelyClosed.map((r) => r.id)).toEqual(["a"]);
  });

  // The banner renders `group.length > 0`, so a reason resolving to undefined
  // throws rather than rendering nothing.
  test("every reason still gets an array, always", () => {
    const groups = splitUnclear([]);

    expect(groups.ambiguous).toEqual([]);
    expect(groups.empty).toEqual([]);
    expect(groups.unresolved).toEqual([]);
    expect(groups.likelyClosed).toEqual([]);
  });
});
