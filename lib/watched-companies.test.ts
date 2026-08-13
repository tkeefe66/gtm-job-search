import { describe, expect, test } from "vitest";
import { normalizeCompanyName } from "./role-key";
import { isCompanyWatched } from "./watched-companies";

function keysFor(names: string[]): Set<string> {
  return new Set(names.map(normalizeCompanyName));
}

describe("isCompanyWatched", () => {
  test("Clay, clay, CLAY, and '  Clay  ' all resolve to one identity", () => {
    const watched = keysFor(["Clay"]);
    const variants = ["Clay", "clay", "CLAY", "  Clay  "];
    // Guard the .every below: an empty list would make .every vacuously true.
    expect(variants.length).toBeGreaterThan(0);
    expect(variants.every((v) => isCompanyWatched(v, watched))).toBe(true);
  });

  test("a name with U+00A0 normalizes the same as one with a regular space", () => {
    // Built with an explicit \xa0 escape, not a pasted character — a literal
    // U+00A0 is invisible in a diff, and a previous build in this repo lost
    // one exactly that way. The watched set is keyed from the
    // non-breaking-space spelling; the lookup uses a regular space, so this
    // fails unless isCompanyWatched routes through a whitespace-collapsing
    // normalizer.
    const nbspName = "Big" + "\xa0" + "Co";
    const watched = keysFor([nbspName]);
    expect(isCompanyWatched("Big Co", watched)).toBe(true);
  });

  test("an unrelated company is not watched", () => {
    // Catches an implementation that always returns true (e.g. comparing
    // against an empty/wrong key by mistake).
    const watched = keysFor(["Clay"]);
    expect(isCompanyWatched("Gong", watched)).toBe(false);
  });

  test("a company removed from the watched set (soft-disabled) reads as not watched", () => {
    const watched = keysFor(["Clay", "Gong"]);
    watched.delete(normalizeCompanyName("Clay"));
    expect(isCompanyWatched("clay", watched)).toBe(false);
    expect(isCompanyWatched("Gong", watched)).toBe(true);
  });
});
