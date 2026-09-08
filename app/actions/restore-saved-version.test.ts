// app/actions/restore-saved-version.test.ts
import { describe, expect, it } from "vitest";
import { shouldCheckpoint } from "@/lib/checkpoint-decision";

const draft = { themes: ["ops"], selection: { positioningId: "gtm", bullets: {} }, overrides: {} };

describe("shouldCheckpoint", () => {
  // Mutation this catches: comparing content_hash (a hash of HTML) instead of
  // content. A pre-021 row has content null, so an HTML match would suppress the
  // checkpoint and the restore would overwrite the draft's only copy — the row
  // that "matched" cannot restore it back, because its own content is null.
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
