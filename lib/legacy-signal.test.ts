import { describe, expect, test } from "vitest";
import { legacySignalFrom } from "./legacy-signal";

describe("legacySignalFrom", () => {
  test("composes all three fields into one legible line", () => {
    expect(
      legacySignalFrom({ raised: "$400M", stage: "Series D", lead_investor: "a16z" })
    ).toBe("Raised $400M (Series D) led by a16z");
  });

  test("stage alone, with no raised amount, is not parenthesized", () => {
    expect(legacySignalFrom({ stage: "Series D" })).toBe("Series D");
  });

  test("raised alone", () => {
    expect(legacySignalFrom({ raised: "$400M" })).toBe("Raised $400M");
  });

  test("lead_investor alone", () => {
    expect(legacySignalFrom({ lead_investor: "a16z" })).toBe("led by a16z");
  });

  test("raised and lead_investor, no stage", () => {
    expect(legacySignalFrom({ raised: "$400M", lead_investor: "a16z" })).toBe(
      "Raised $400M led by a16z"
    );
  });

  test("all three absent renders an empty string, not 'undefined'", () => {
    expect(legacySignalFrom({})).toBe("");
  });
});
