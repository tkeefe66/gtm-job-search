// app/actions/restore-saved-version.test.ts
import { describe, expect, it } from "vitest";
import { restoreWouldChangeNothing, shouldCheckpoint } from "@/lib/checkpoint-decision";

const draft = { themes: ["ops"], selection: { positioningId: "gtm", bullets: {} }, overrides: {} };

/** A structurally-identical but reference-distinct copy — every nested value
 *  is rebuilt from scratch via the JSON round trip, so nothing in it shares a
 *  reference with `draft`. Needed because `{ ...draft }` is a SHALLOW copy:
 *  its `selection` and `overrides` are the exact same objects as `draft`'s,
 *  so any comparison that only checks those fields by reference passes
 *  trivially there and proves nothing about a by-value comparison. */
function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

describe("shouldCheckpoint", () => {
  // Mutation this catches: an implementation that special-cases null content
  // TOWARD suppression (e.g. `if (newest.content === null) return false;`).
  // That is the real, live risk this guards: a pre-021 row's content is null,
  // and suppressing against it destroys the draft's only copy.
  //
  // What this test does NOT prove: that the null guard exists at all.
  // Deleting the guard and falling straight through to the JSON.stringify
  // comparison still passes THIS fixture by coincidence —
  // `JSON.stringify(null)` is the string `"null"`, which is never equal to a
  // stringified object, so the fallthrough still returns `true` here even
  // with no guard. (Comparing `content_hash` instead of `content` is not a
  // mutation this signature can express at all — `newest: { content: unknown
  // | null }` carries no hash field to compare.)
  it("always checkpoints against a row that records no content", () => {
    expect(shouldCheckpoint(draft, { content: null })).toBe(true);
  });

  // Mutation this catches: suppressing whenever a newest row exists at all.
  it("checkpoints when the draft differs from the newest row", () => {
    expect(shouldCheckpoint(draft, { content: { ...draft, themes: ["data"] } })).toBe(true);
  });

  // Mutation this catches: never suppressing, which writes a full HTML document
  // every time the user opens a saved résumé.
  it("does not checkpoint when the draft is already the newest row", () => {
    expect(shouldCheckpoint(draft, { content: { ...draft } })).toBe(false);
  });

  // Mutation this catches: comparing only `themes` instead of the whole
  // content, e.g.
  //   JSON.stringify(draft.themes) !== JSON.stringify(newest.content.themes)
  // That mutant passes every OTHER case in this file — the "differs" case
  // above happens to vary themes, and the "already the newest" case's
  // `{ ...draft }` shares `overrides`/`selection` by reference either way —
  // so it must be exercised on a content difference that themes cannot see.
  it("checkpoints when the draft differs from the newest row only in overrides", () => {
    const newest = { ...draft, overrides: { pageMargin: "1in" } };
    expect(shouldCheckpoint(draft, { content: newest })).toBe(true);
  });

  // Same mutation as above, isolated to `selection` instead of `overrides`.
  it("checkpoints when the draft differs from the newest row only in selection", () => {
    const newest = { ...draft, selection: { positioningId: "gtm", bullets: { a: ["x"] } } };
    expect(shouldCheckpoint(draft, { content: newest })).toBe(true);
  });

  // Mutation this catches: a reference-based (or partially-by-reference)
  // comparison — e.g. one that compares `themes` by value but `selection`/
  // `overrides` by `!==` — which would return `true` here even though the two
  // sides are structurally identical, because a deep copy shares no nested
  // references with `draft`. This is what proves the comparison is by VALUE,
  // not by reference: unlike the "already the newest" case above (built from
  // a shallow `{ ...draft }`, whose nested fields alias `draft`'s), nothing
  // here can pass by accidentally sharing an object.
  it("does not checkpoint against a deep copy sharing no references", () => {
    expect(shouldCheckpoint(draft, { content: deepCopy(draft) })).toBe(false);
  });

  // Mutation this catches: treating "no draft" as "nothing to compare, so write
  // one". There is nothing to preserve, and the row would duplicate the restored
  // document.
  it("does not checkpoint when there is no draft at all", () => {
    expect(shouldCheckpoint(null, { content: { ...draft } })).toBe(false);
    expect(shouldCheckpoint(null, null)).toBe(false);
  });

  // Mutation this catches: suppressing when no saved row exists yet. The draft
  // is unprotected and a restore would destroy it.
  it("checkpoints a draft when the job has no saved rows yet", () => {
    expect(shouldCheckpoint(draft, null)).toBe(true);
  });
});

// The second suppression, and the reason it cannot be folded into
// shouldCheckpoint: shouldCheckpoint compares the draft against the newest
// LIVE saved row, and after one restore that row is the checkpoint the restore
// itself wrote.
describe("restoreWouldChangeNothing", () => {
  // Mutation this catches: OMITTING the check entirely at the call site
  // (restore-saved-version.ts Step 4). Restore S, then back-navigate and click
  // "Edit this version" on S again: the draft is now S and the newest live row
  // is the checkpoint holding the OLD draft D, so shouldCheckpoint still says
  // yes — a worthless second checkpoint holding S is written AND the demotion
  // moves C1, the only copy of D, from 30 days down to 3. `disabled={isPending}`
  // guards a double-click, not a back navigation.
  it("suppresses a restore of the version the draft already is", () => {
    const newestIsTheCheckpoint = { content: { ...draft, themes: ["old"] } };
    // shouldCheckpoint alone would write one...
    expect(shouldCheckpoint(draft, newestIsTheCheckpoint)).toBe(true);
    // ...and this is what stops it, because restoring S over a draft that is
    // already S changes nothing, so there is nothing to preserve.
    expect(restoreWouldChangeNothing(draft, deepCopy(draft))).toBe(true);
  });

  // Mutation this catches: comparing by reference, which would report a
  // structurally identical deep copy as different and let the redundant
  // checkpoint through. Covered above too; asserted here on the negative side
  // so a by-value comparison is pinned in both directions.
  it("does not suppress when the restored version differs from the draft", () => {
    expect(restoreWouldChangeNothing(draft, { ...draft, themes: ["data"] })).toBe(false);
    expect(
      restoreWouldChangeNothing(draft, { ...draft, overrides: { pageMargin: "1in" } })
    ).toBe(false);
  });

  // Mutation this catches: dropping the null/undefined guards, where
  // JSON.stringify(undefined) === JSON.stringify(undefined) makes two absent
  // values compare EQUAL and suppresses the checkpoint of a draft that exists.
  it("never suppresses when either side is absent", () => {
    expect(restoreWouldChangeNothing(null, null)).toBe(false);
    expect(restoreWouldChangeNothing(undefined, undefined)).toBe(false);
    expect(restoreWouldChangeNothing(draft, null)).toBe(false);
    expect(restoreWouldChangeNothing(null, draft)).toBe(false);
  });
});
