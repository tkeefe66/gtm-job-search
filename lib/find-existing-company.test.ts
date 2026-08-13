import { describe, expect, test } from "vitest";
import { findExistingCompany } from "./find-existing-company";

interface Row {
  company: string;
  careers_url: string | null;
}

function rows(names: string[]): Row[] {
  return names.map((company) => ({ company, careers_url: null }));
}

describe("findExistingCompany", () => {
  test("matches a row differing only by internal whitespace", () => {
    // The core covering test for task 5's fix-round #1: SQL `lower()` does
    // not collapse internal whitespace, so a lower()-based lookup misses
    // this and a subsequent .eq("company", ...) write silently no-ops. This
    // must pass because the match happens in TS via normalizeCompanyName.
    const found = findExistingCompany(rows(["Big  Co"]), "Big Co");
    expect(found).toBeDefined();
    expect(found?.company).toBe("Big  Co");
  });

  test("matches a row differing by case", () => {
    const found = findExistingCompany(rows(["Clay"]), "clay");
    expect(found?.company).toBe("Clay");
  });

  test("matches a row differing by leading/trailing whitespace", () => {
    const found = findExistingCompany(rows(["Clay"]), "  Clay  ");
    expect(found?.company).toBe("Clay");
  });

  test("matches a row differing by U+00A0 vs a regular space", () => {
    // Built with an explicit \xa0 escape, not a pasted character — a
    // literal U+00A0 is invisible in a diff.
    const nbspStored = "Big" + "\xa0" + "Co";
    const found = findExistingCompany(rows([nbspStored]), "Big Co");
    expect(found?.company).toBe(nbspStored);
  });

  test("returns undefined when no row matches", () => {
    // Catches an implementation that always returns the first row
    // regardless of the name (or otherwise ignores `name` entirely).
    const found = findExistingCompany(rows(["Clay", "Gong"]), "Salesloft");
    expect(found).toBeUndefined();
  });

  test("returns undefined against an empty row set", () => {
    const found = findExistingCompany([], "Clay");
    expect(found).toBeUndefined();
  });
});
