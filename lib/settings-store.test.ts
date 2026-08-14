import { describe, expect, test } from "vitest";
import {
  CRITERIA_CHANGED_AT_KEY,
  CRITERIA_CHANGED_AT_SQL,
  LIST_SETTING_KEYS,
  NUMBER_SETTING_KEYS,
  TEXT_SETTING_KEYS,
  ceilingFrom,
  mergeSettings,
  numberFrom,
  SETTING_KEYS,
} from "./settings-store";
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

  test("hands out a COPY of an un-overridden array, never the constant itself", () => {
    // toEqual cannot see this: the copy and the constant have identical
    // contents, so only reference identity distinguishes the two paths.
    // Without the copy, criteria.titles IS DEFAULT_TARGET_TITLES — the module
    // constant every caller in the process shares as its fallback.
    const merged = mergeSettings(DEFAULT_CRITERIA, []);
    expect(merged.titles).toEqual(DEFAULT_CRITERIA.titles);
    expect(merged.titles).not.toBe(DEFAULT_CRITERIA.titles);
    expect(merged.locations).not.toBe(DEFAULT_CRITERIA.locations);
    expect(merged.stackTerms).not.toBe(DEFAULT_CRITERIA.stackTerms);
  });

  test("mutating a merged list cannot corrupt the shipped fallback", () => {
    // The failure the copy prevents, played out: a future in-place sort or
    // push on a criteria list would otherwise poison the defaults the crawler
    // and every search path degrade to, for the life of the process.
    const before = DEFAULT_CRITERIA.titles.length;
    expect(before).toBeGreaterThan(0);
    const merged = mergeSettings(DEFAULT_CRITERIA, []);
    merged.titles.push("Chief Vibes Officer");
    expect(DEFAULT_CRITERIA.titles).toHaveLength(before);
    expect(DEFAULT_CRITERIA.titles).not.toContain("Chief Vibes Officer");
  });

  test("a stored array is copied too, so the merged object aliases nothing", () => {
    const stored = ["X", "Y"];
    const merged = mergeSettings({ titles: ["A"] }, [{ key: "titles", value: stored }]);
    expect(merged.titles).toEqual(stored);
    expect(merged.titles).not.toBe(stored);
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

describe("numberFrom / ceilingFrom", () => {
  const rows = [
    { key: "searchCeiling", value: 15 },
    { key: "titles", value: ["A"] },
  ];

  test("picks the stored number out of rows already read", () => {
    expect(ceilingFrom(rows)).toBe(15);
  });

  test("a missing row reads as not set", () => {
    expect(ceilingFrom([{ key: "titles", value: ["A"] }])).toBeNull();
  });

  test("a non-number row reads as not set rather than as a cap", () => {
    // A hand-edit storing "15" as a string must not become a ceiling — it
    // would flow into pickQueries and max_uses as a string.
    expect(ceilingFrom([{ key: "searchCeiling", value: "15" }])).toBeNull();
    expect(numberFrom([{ key: "compFloor", value: null }], "compFloor")).toBeNull();
  });

  test("reads the key it was asked for, not whichever row came first", () => {
    expect(numberFrom([...rows, { key: "compFloor", value: 150000 }], "compFloor")).toBe(
      150000
    );
  });
});

describe("criteria-changed stamp", () => {
  test("is scoped to one key, never an aggregate over the whole table", () => {
    // The scoping decision this whole constant exists for. max(updated_at)
    // across app_settings would also stamp on searchCeiling and compFloor —
    // neither changes what the crawler looks for, and stamping on them
    // suppresses stale-posting closure for ~2 crawl cycles per company.
    expect(CRITERIA_CHANGED_AT_SQL).toContain("where key = $1");
    expect(CRITERIA_CHANGED_AT_SQL).not.toContain("max(");
    expect(CRITERIA_CHANGED_AT_SQL).toContain("#>> '{}'");
  });

  test("its key is NOT a mergeable setting", () => {
    // It is a stamp the app writes, not a user-editable setting. If it ever
    // landed in SETTING_KEYS and DEFAULT_CRITERIA, the timestamp would merge
    // into the criteria object and be handed to the crawler as criteria.
    expect(Object.values(SETTING_KEYS)).not.toContain(CRITERIA_CHANGED_AT_KEY);
    expect(CRITERIA_CHANGED_AT_KEY in DEFAULT_CRITERIA).toBe(false);
  });

  test("a stored stamp cannot leak into the merged criteria", () => {
    const merged = mergeSettings(DEFAULT_CRITERIA, [
      { key: CRITERIA_CHANGED_AT_KEY, value: "2026-08-13T00:00:00.000Z" },
    ]);
    expect(merged).toEqual(DEFAULT_CRITERIA);
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

describe("setting-key shape partition", () => {
  const grouped = [...LIST_SETTING_KEYS, ...TEXT_SETTING_KEYS, ...NUMBER_SETTING_KEYS];

  test("every setting is classified exactly once", () => {
    // saveCriteriaList and saveCriteriaText are typed on these groups. A key
    // in neither could not be saved at all; a key in both would let
    // saveCriteriaText write a bare string under "titles", which mergeSettings'
    // shape guard then ignores forever while the save reports success.
    expect(grouped.length).toBeGreaterThan(0);
    expect([...grouped].sort()).toEqual([...Object.values(SETTING_KEYS)].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  test("the groups match the shape each default actually has", () => {
    // The partition is only meaningful if it describes the real stored shapes.
    // DEFAULT_CRITERIA does not carry the two numeric settings, so they are
    // checked by absence from it rather than by typeof.
    for (const key of LIST_SETTING_KEYS) {
      expect(Array.isArray(DEFAULT_CRITERIA[key])).toBe(true);
    }
    for (const key of TEXT_SETTING_KEYS) {
      expect(typeof DEFAULT_CRITERIA[key]).toBe("string");
    }
    for (const key of NUMBER_SETTING_KEYS) {
      expect(key in DEFAULT_CRITERIA).toBe(false);
    }
  });

  test("the stamp key is in no group — it is not user-editable", () => {
    expect(grouped).not.toContain(CRITERIA_CHANGED_AT_KEY);
  });
});
