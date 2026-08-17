import { describe, expect, test } from "vitest";
import { emptyBrainRefusal } from "@/lib/search-criteria";

describe("emptyBrainRefusal", () => {
  test("names the fit brain and points at where to fix it", () => {
    expect(emptyBrainRefusal()).toContain("fit brain");
    expect(emptyBrainRefusal()).toMatch(/Settings|onboarding/);
  });

  test("is never empty — a caller's presence check depends on it", () => {
    // Same contract the closed-set string in scoreFit's catch has: the message
    // is non-empty on every path, so `error !== undefined` separates failure
    // from success without the text having to be truthy.
    expect(emptyBrainRefusal().length).toBeGreaterThan(0);
  });
});
