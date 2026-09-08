// app/actions/restore-saved-version.test.ts
import { describe, expect, it } from "vitest";
import { shouldCheckpoint } from "@/lib/checkpoint-decision";

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
