// lib/saved-edit-affordance.test.ts
import { describe, expect, it } from "vitest";
import { savedEditAffordance } from "@/lib/saved-edit-affordance";

describe("savedEditAffordance", () => {
  it("offers a restore when the row is reproducible and its job is alive", () => {
    expect(savedEditAffordance({ hasContent: true, jobId: "job-1" }).kind).toBe("restore");
  });

  // Mutation this catches: treating a pre-021 row as restorable. Its content is
  // null, so a restore would upsert null over the draft.
  it("offers the draft only when the row predates stored content", () => {
    const a = savedEditAffordance({ hasContent: false, jobId: "job-1" });
    expect(a.kind).toBe("draftOnly");
    expect(a.kind === "draftOnly" && a.note).toContain("may differ");
  });

  // Mutation this catches: checking hasContent BEFORE jobId. With no job there
  // is no tailored_resumes row (its job_id is NOT NULL) and no tailor screen to
  // open, so unavailable has to win. A fixture pairing a null job only with
  // absent content cannot tell the two orderings apart — this is the case that
  // discriminates, and the sibling test below is the one that would pass either
  // way.
  it("is unavailable when the job is gone even though content exists", () => {
    const a = savedEditAffordance({ hasContent: true, jobId: null });
    expect(a.kind).toBe("unavailable");
    expect(a.kind === "unavailable" && a.note).toContain("deleted");
  });

  it("is unavailable when the job is gone and there is no content", () => {
    expect(savedEditAffordance({ hasContent: false, jobId: null }).kind).toBe("unavailable");
  });
});
