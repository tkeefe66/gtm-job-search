import { describe, test, it, expect } from "vitest";
import { appliedDatePatch, todayStamp } from "./applied-date";
import { JOB_STATUSES } from "./types";

const TODAY = "2026-08-15";

describe("appliedDatePatch", () => {
  test("stamps today when a role first moves to Applied", () => {
    expect(appliedDatePatch("Applied", null, TODAY)).toEqual({
      applied_date: TODAY,
    });
  });

  // Driven off JOB_STATUSES rather than a hand-written list. The hand-written
  // one contained "Take-home" — not a JobStatus and not in JOB_STATUSES — so
  // the test asserted about a status that does not exist while leaving eight
  // real ones, the whole interview ladder among them, uncovered. Typing the
  // parameter as JobStatus now makes that particular mistake a compile error;
  // deriving the list from the constant makes the coverage total and keeps it
  // total when a status is added.
  test("no status other than Applied stamps anything", () => {
    const others = JOB_STATUSES.filter((s) => s !== "Applied");
    expect(others).toHaveLength(JOB_STATUSES.length - 1);
    for (const s of others) {
      expect(appliedDatePatch(s, null, TODAY)).toEqual({});
    }
  });

  // The date answers "when did I apply", so the FIRST answer is the true one.
  // Bouncing Applied → Rejected → Applied must not rewrite history; the
  // dead updateJobStatus this replaces stamped unconditionally.
  test("an existing date is never overwritten", () => {
    expect(appliedDatePatch("Applied", "2026-07-01", TODAY)).toEqual({});
  });

  // The OTHER leg of that round trip, which the comment above promised and no
  // test asserted: every non-Applied case passed existing: null, so a mutant
  // that cleared the date on the way out would have survived the suite.
  test("moving out of Applied leaves an existing date alone", () => {
    for (const s of ["Rejected", "Passed", "Not Interested", "New"] as const) {
      expect(appliedDatePatch(s, "2026-07-01", TODAY)).toEqual({});
    }
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

  it("still stamps when Applied has been renamed, because the KEY is what is stored", () => {
    // The user renamed "Applied" to "Submitted" on /settings. The label changed;
    // the key did not, and the key is what reaches this function.
    expect(appliedDatePatch("Applied", null, "2026-08-17")).toEqual({
      applied_date: "2026-08-17",
    });
  });

  it("does not stamp for a custom status the user added", () => {
    expect(appliedDatePatch("take-home", null, "2026-08-17")).toEqual({});
  });
});

describe("todayStamp", () => {
  // The `now` parameter exists only so this can be pinned, and nothing used it
  // — which is how the module shipped a UTC date rendered beside local ones.
  test("formats as YYYY-MM-DD", () => {
    expect(todayStamp(new Date(2026, 7, 15, 12, 0, 0))).toBe("2026-08-15");
  });

  test("pads single-digit months and days", () => {
    expect(todayStamp(new Date(2026, 0, 3, 12, 0, 0))).toBe("2026-01-03");
  });

  // The regression itself: under the old toISOString().slice(0, 10) this
  // returned "2026-08-16" for any viewer west of Greenwich, so a role found
  // "today, Aug 15" rendered `applied 2026-08-16` on the very same line.
  //
  // Honest limitation: `new Date(y, m, d, ...)` builds a LOCAL moment, so this
  // only FAILS against the old implementation when the suite runs off UTC —
  // true on the developer's machine (Denver), not true in a UTC container. It
  // pins the intent everywhere and catches the regression where the bug was
  // actually observed. Pinning it unconditionally would mean forcing TZ for the
  // whole suite, which is a bigger change than this fix warrants.
  test("a late-evening local time stamps that day, not the next", () => {
    expect(todayStamp(new Date(2026, 7, 15, 23, 30, 0))).toBe("2026-08-15");
  });

  // The mirror case, which breaks east of Greenwich instead.
  test("an early-morning local time stamps that day, not the previous", () => {
    expect(todayStamp(new Date(2026, 7, 15, 0, 30, 0))).toBe("2026-08-15");
  });
});
