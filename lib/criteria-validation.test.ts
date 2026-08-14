import { describe, expect, test } from "vitest";
import {
  FIT_BRAIN_MAX_CHARS,
  normalizeList,
  validateList,
  validateText,
} from "./criteria-validation";

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

describe("validateText", () => {
  test("rejects an empty value by name, with no warning", () => {
    const r = validateText("   ", "Fit brain", 4000);
    expect(r.error).toContain("Fit brain");
    expect(r.warning).toBeNull();
  });

  test("passes a normal value with neither an error nor a warning", () => {
    const r = validateText("Tom is a RevOps leader.", "Fit brain", 4000);
    expect(r.error).toBeNull();
    expect(r.warning).toBeNull();
  });

  test("exactly maxChars does not warn", () => {
    // Boundary. A `>=` here would warn on a value that is exactly at the
    // documented guideline, which is inside it, not over it.
    const r = validateText("x".repeat(4000), "Fit brain", 4000);
    expect(r.warning).toBeNull();
    expect(r.error).toBeNull();
  });

  test("one character over maxChars warns", () => {
    const r = validateText("x".repeat(4001), "Fit brain", 4000);
    expect(r.warning).toContain("Fit brain");
    expect(r.warning).toContain("4001");
    expect(r.warning).toContain("4000");
  });

  test("warns rather than blocks — an over-long value still has no error", () => {
    // The distinction the two-field return exists for. If `error` were set
    // here the settings form would refuse a save the spec says must succeed.
    const r = validateText("x".repeat(9000), "Fit brain", 4000);
    expect(r.error).toBeNull();
    expect(r.warning).not.toBeNull();
  });

  test("measures the trimmed length, which is what gets stored", () => {
    // 4000 characters of content in 4200 characters of input: saveCriteriaText
    // trims before writing, so the padding costs nothing and must not warn.
    const padded = " ".repeat(100) + "x".repeat(4000) + " ".repeat(100);
    expect(validateText(padded, "Fit brain", 4000).warning).toBeNull();
  });

  test("the shipped fit-brain guideline is 4,000 characters", () => {
    expect(FIT_BRAIN_MAX_CHARS).toBe(4000);
  });
});
