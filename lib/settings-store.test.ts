import { describe, expect, test } from "vitest";
import { mergeSettings, SETTING_KEYS } from "./settings-store";
import { DEFAULT_CRITERIA } from "./search-criteria";

describe("mergeSettings", () => {
  test("returns defaults when no rows are stored", () => {
    const defaults = { titles: ["A", "B"], rule: "r" };
    expect(mergeSettings(defaults, [])).toEqual(defaults);
  });

  test("a stored row overrides its default", () => {
    const defaults = { titles: ["A"], rule: "r" };
    const merged = mergeSettings(defaults, [{ key: "titles", value: ["X", "Y"] }]);
    expect(merged.titles).toEqual(["X", "Y"]);
    expect(merged.rule).toBe("r");
  });

  test("a row with an unknown key is ignored, not merged in", () => {
    const defaults = { titles: ["A"] };
    const merged = mergeSettings(defaults, [{ key: "bogus", value: 1 }]);
    expect(merged).toEqual({ titles: ["A"] });
    expect("bogus" in merged).toBe(false);
  });

  test("a stored null does not blank out a default", () => {
    const defaults = { titles: ["A"] };
    expect(mergeSettings(defaults, [{ key: "titles", value: null }]).titles).toEqual(["A"]);
  });

  test("does not mutate the defaults object", () => {
    const defaults = { titles: ["A"] };
    mergeSettings(defaults, [{ key: "titles", value: ["X"] }]);
    expect(defaults.titles).toEqual(["A"]);
  });

  test("ignores a value of the wrong shape rather than poisoning the crawler", () => {
    // A string here would make titleListForPrompt call .join on a string and
    // throw mid-crawl. Must fall back to the default, not merge.
    const defaults = { titles: ["A"], rule: "r" };
    expect(mergeSettings(defaults, [{ key: "titles", value: "oops" }]).titles).toEqual(["A"]);
    expect(mergeSettings(defaults, [{ key: "rule", value: ["oops"] }]).rule).toBe("r");
  });

  test("ignores a scalar value whose typeof mismatches the default", () => {
    // Both sides are non-arrays here, so this exercises the second half of the
    // shape guard (the typeof check) rather than the Array.isArray branch
    // above — a default that is a string receiving a stored number.
    const defaults = { compFloor: "150000" };
    expect(mergeSettings(defaults, [{ key: "compFloor", value: 150000 }]).compFloor).toBe(
      "150000"
    );
  });
});

describe("SETTING_KEYS alignment", () => {
  test("every Criteria field has a matching SETTING_KEYS value", () => {
    // One-directional on purpose: searchCeiling and compFloor are settings
    // but NOT Criteria fields, so a bijection assertion would fail. Drift
    // in the other direction makes every save a silent no-op.
    const fields = Object.keys(DEFAULT_CRITERIA);
    expect(fields.length).toBeGreaterThan(0);
    for (const f of fields) expect(Object.values(SETTING_KEYS)).toContain(f);
  });
});
