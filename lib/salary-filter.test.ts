import { describe, expect, test } from "vitest";
import {
  COMP_BUCKET_TAGS,
  passesCompFilters,
  salaryBucketFor,
  type SalaryBucket,
} from "./salary-filter";

const job = (salary_range: string | null) => ({ salary_range });

describe("salaryBucketFor", () => {
  test("meets when the base max clears the floor", () => {
    expect(salaryBucketFor(job("$180,000 - $220,000"), 200000)).toBe("meets");
  });

  test("below when the base max is under the floor", () => {
    expect(salaryBucketFor(job("$120,000 - $150,000"), 200000)).toBe("below");
  });

  test("meets exactly at the floor", () => {
    // Pins `>=`, not `>`. A posting whose top of band IS the stated minimum
    // meets the minimum; `>` drops the exact-match role silently.
    expect(salaryBucketFor(job("$150,000 - $200,000"), 200000)).toBe("meets");
    // One dollar under is the other side of the same boundary.
    expect(salaryBucketFor(job("$150,000 - $199,999"), 200000)).toBe("below");
  });

  test("no-range when the posting listed nothing", () => {
    expect(salaryBucketFor(job(null), 200000)).toBe("no-range");
    expect(salaryBucketFor(job(""), 200000)).toBe("no-range");
  });

  test("unreadable is distinct from no-range", () => {
    // The two facts are different: "the employer published nothing" versus "we
    // captured text we could not read". The second is a parser gap, and
    // collapsing it into no-range hides that gap behind a UI that looks fine.
    expect(salaryBucketFor(job("Competitive DOE"), 200000)).toBe("unreadable");
    expect(salaryBucketFor(job("Competitive DOE"), 200000)).not.toBe(
      salaryBucketFor(job(null), 200000)
    );
  });

  test("an OTE-only figure is its own bucket, not lumped in with below-floor", () => {
    // `.not.toBe("meets")` passes for below / no-range / unreadable alike — it
    // cannot catch the very mis-bucketing it exists to guard. Assert the value.
    // Returning "below" here makes a $300-340k OTE role — whose base almost
    // certainly clears any realistic floor — vanish under "Meets minimum",
    // filed alongside genuinely underpaying roles.
    expect(salaryBucketFor(job("$300,000 - $340,000 OTE"), 200000)).toBe("ote");
    // Also OTE when the OTE figure is far UNDER the floor: the bucket is about
    // what kind of figure it is, not how it compares to a base floor.
    expect(salaryBucketFor(job("$90,000 - $95,000 OTE"), 200000)).toBe("ote");
    // And when the floor is unset, so no comparison happens at all.
    expect(salaryBucketFor(job("$300,000 - $340,000 OTE"), null)).toBe("ote");
  });

  test("with no floor set, anything with a readable base range meets", () => {
    expect(salaryBucketFor(job("$90,000 - $95,000"), null)).toBe("meets");
    expect(salaryBucketFor(job(null), null)).toBe("no-range");
    expect(salaryBucketFor(job("Competitive DOE"), null)).toBe("unreadable");
  });

  test("compares against base, not OTE, when a posting states both", () => {
    // The whole point of the base/OTE split, seen from the filter: the OTE max
    // clears the floor and the base max does not.
    expect(
      salaryBucketFor(job("$280,000 - $290,000 (base); $305,000 - $365,000 OTE"), 300000)
    ).toBe("below");
  });

  test("never returns a bucket outside the declared union", () => {
    const ALL: SalaryBucket[] = ["meets", "below", "ote", "no-range", "unreadable"];
    const SAMPLES = [
      null,
      "",
      "   ",
      "$180,000 - $220,000",
      "$120,000 - $150,000",
      "$300,000 - $340,000 OTE",
      "Competitive DOE",
      "$200K–$280K",
    ];
    expect(SAMPLES.length).toBe(8);
    for (const raw of SAMPLES) {
      expect(ALL).toContain(salaryBucketFor(job(raw), 200000));
    }
  });
});

describe("passesCompFilters", () => {
  const OFF = { meetsOnly: false, hideNoRange: false };

  // One posting per bucket, so each assertion below names the bucket it means.
  const SAMPLE: Record<SalaryBucket, string | null> = {
    meets: "$180,000 - $220,000",
    below: "$120,000 - $150,000",
    ote: "$300,000 - $340,000 OTE",
    "no-range": null,
    unreadable: "Competitive DOE",
  };
  const FLOOR = 200000;

  test("the samples really do cover all five buckets", () => {
    // Without this, a fixture that silently drifts into the wrong bucket would
    // make every expectation below assert something other than what it says.
    for (const [bucket, raw] of Object.entries(SAMPLE)) {
      expect(salaryBucketFor(job(raw), FLOOR)).toBe(bucket);
    }
    expect(Object.keys(SAMPLE).length).toBe(5);
  });

  test("both toggles off hides nothing", () => {
    const raws = Object.values(SAMPLE);
    expect(raws.length).toBe(5);
    for (const raw of raws) {
      expect(passesCompFilters(job(raw), FLOOR, OFF)).toBe(true);
    }
  });

  test("meets-minimum hides only the below-floor bucket", () => {
    const on = { ...OFF, meetsOnly: true };
    expect(passesCompFilters(job(SAMPLE.below), FLOOR, on)).toBe(false);
    expect(passesCompFilters(job(SAMPLE.meets), FLOOR, on)).toBe(true);
  });

  test("meets-minimum keeps OTE-only roles visible", () => {
    // The regression this whole task turns on: an OTE role has no base figure
    // to compare, so hiding it under a BASE floor asserts something the posting
    // never said.
    const on = { ...OFF, meetsOnly: true };
    expect(passesCompFilters(job(SAMPLE.ote), FLOOR, on)).toBe(true);
  });

  test("meets-minimum does not hide roles that merely listed no readable range", () => {
    // "Pays too little" and "didn't tell me" are different facts and get
    // different toggles; folding them together makes one control do two jobs.
    const on = { ...OFF, meetsOnly: true };
    expect(passesCompFilters(job(SAMPLE["no-range"]), FLOOR, on)).toBe(true);
    expect(passesCompFilters(job(SAMPLE.unreadable), FLOOR, on)).toBe(true);
  });

  test("hide-no-range hides both the unpublished and the unreadable", () => {
    const on = { ...OFF, hideNoRange: true };
    expect(passesCompFilters(job(SAMPLE["no-range"]), FLOOR, on)).toBe(false);
    expect(passesCompFilters(job(SAMPLE.unreadable), FLOOR, on)).toBe(false);
  });

  test("hide-no-range leaves priced roles alone, OTE included", () => {
    const on = { ...OFF, hideNoRange: true };
    expect(passesCompFilters(job(SAMPLE.meets), FLOOR, on)).toBe(true);
    expect(passesCompFilters(job(SAMPLE.below), FLOOR, on)).toBe(true);
    expect(passesCompFilters(job(SAMPLE.ote), FLOOR, on)).toBe(true);
  });

  test("the two toggles are independent, not one exclusive filter", () => {
    const both = { meetsOnly: true, hideNoRange: true };
    expect(passesCompFilters(job(SAMPLE.meets), FLOOR, both)).toBe(true);
    expect(passesCompFilters(job(SAMPLE.ote), FLOOR, both)).toBe(true);
    expect(passesCompFilters(job(SAMPLE.below), FLOOR, both)).toBe(false);
    expect(passesCompFilters(job(SAMPLE["no-range"]), FLOOR, both)).toBe(false);
    expect(passesCompFilters(job(SAMPLE.unreadable), FLOOR, both)).toBe(false);
  });

  test("with no floor set, meets-minimum hides nothing", () => {
    // The UI hides the toggle when no floor is set; this pins that the logic
    // agrees, so a stale `meetsOnly` cannot blank the table after the floor is
    // cleared.
    const on = { ...OFF, meetsOnly: true };
    expect(passesCompFilters(job(SAMPLE.below), null, on)).toBe(true);
    expect(passesCompFilters(job(SAMPLE.meets), null, on)).toBe(true);
  });
});

describe("COMP_BUCKET_TAGS", () => {
  test("tags the three buckets whose figure is not a comparable base", () => {
    expect(COMP_BUCKET_TAGS["no-range"]).toBe("No range listed");
    expect(COMP_BUCKET_TAGS.unreadable).toBe("Range unreadable");
    expect(COMP_BUCKET_TAGS.ote).toBe("OTE only");
  });

  test("gives no-range and unreadable different labels", () => {
    // Same reason they are different buckets: one is the employer's silence,
    // the other is our parser. A shared label re-hides the parser gap in the
    // one place a human would have seen it.
    expect(COMP_BUCKET_TAGS["no-range"]).not.toBe(COMP_BUCKET_TAGS.unreadable);
  });

  test("does not tag rows that stated a comparable base range", () => {
    expect(COMP_BUCKET_TAGS.meets).toBeUndefined();
    expect(COMP_BUCKET_TAGS.below).toBeUndefined();
  });
});
