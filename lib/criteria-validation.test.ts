import { describe, expect, test } from "vitest";
import { normalizeList, validateList } from "./criteria-validation";

describe("normalizeList", () => {
  test("trims entries and drops blanks", () => {
    expect(normalizeList(["  A  ", "", "   ", "B"])).toEqual(["A", "B"]);
  });

  test("de-duplicates case-insensitively, keeping the first spelling", () => {
    expect(normalizeList(["Clay", "clay", "CLAY"])).toEqual(["Clay"]);
  });

  test("collapses internal whitespace, including U+00A0", () => {
    expect(normalizeList(["Head  of" + "\xa0" + "RevOps"])).toEqual(["Head of RevOps"]);
  });
});

describe("validateList", () => {
  test("rejects an empty list by name", () => {
    const r = validateList([], "Target titles");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Target titles");
  });

  test("rejects a list that is empty only after normalizing", () => {
    expect(validateList(["  ", ""], "Locations").ok).toBe(false);
  });

  test("rejects a double quote, which would break query construction", () => {
    const r = validateList(['Head of "Revenue" Ops'], "Target titles");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('"');
  });

  test("accepts a normal list and returns it normalized", () => {
    const r = validateList([" GTM Engineer ", "GTM Engineer"], "Target titles");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(["GTM Engineer"]);
  });
});
