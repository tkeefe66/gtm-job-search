import { describe, test, expect } from "vitest";
import { appliedDatePatch } from "./applied-date";

const TODAY = "2026-08-15";

describe("appliedDatePatch", () => {
  test("stamps today when a role first moves to Applied", () => {
    expect(appliedDatePatch("Applied", null, TODAY)).toEqual({
      applied_date: TODAY,
    });
  });

  test("any other status stamps nothing", () => {
    for (const s of ["New", "Rejected", "Posting Closed", "Offer", "Take-home"]) {
      expect(appliedDatePatch(s, null, TODAY)).toEqual({});
    }
  });

  // The date answers "when did I apply", so the FIRST answer is the true one.
  // Bouncing Applied → Rejected → Applied must not rewrite history; the
  // dead updateJobStatus this replaces stamped unconditionally.
  test("an existing date is never overwritten", () => {
    expect(appliedDatePatch("Applied", "2026-07-01", TODAY)).toEqual({});
  });

  // An empty string is what a cleared form field yields, and it is not a date.
  // Treating it as "already applied" would leave the row permanently blank.
  test("an empty stored value counts as unset", () => {
    expect(appliedDatePatch("Applied", "", TODAY)).toEqual({
      applied_date: TODAY,
    });
  });

  // Returning {} rather than {applied_date: undefined} matters: the patch is
  // spread into an update, and an explicit undefined key would write NULL over
  // a date that is already there.
  test("the no-op result has no keys to spread", () => {
    expect(Object.keys(appliedDatePatch("Applied", "2026-07-01", TODAY))).toHaveLength(0);
    expect(Object.keys(appliedDatePatch("New", null, TODAY))).toHaveLength(0);
  });
});
