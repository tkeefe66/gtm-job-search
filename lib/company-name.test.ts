import { describe, expect, test } from "vitest";

import { betterCompanyName } from "./company-name";

// Measured 2026-09-07 against 120 rows' own schema.org hiringOrganization: the
// stored name differed from the employer's in 8 cases, and NONE was a wrong
// company. Three were "basten" for Baseten — a transcription slip by the
// extraction — which normalizeCompanyName treats as a different employer
// entirely: duplicate Discover cards, a board-slug guess that cannot resolve,
// and a watchlist that never matches.
describe("when the employer's own spelling wins", () => {
  test("a one-character slip is corrected", () => {
    expect(betterCompanyName("basten", "Baseten")).toBe("Baseten");
  });

  test("casing and punctuation alone are corrected too", () => {
    expect(betterCompanyName("pricefx", "Pricefx")).toBe("Pricefx");
    expect(betterCompanyName("Level-Access", "Level Access")).toBe("Level Access");
  });

  // The conservative half, and the reason this is not "always trust the
  // employer". A board's legal entity is a WORSE name than the one the user
  // recognises: Workday returned "4050 Entegris Malaysia SDN Bhd" for a row
  // stored as "Entegris".
  test("a legal entity does not replace the name the user knows", () => {
    expect(betterCompanyName("Entegris", "4050 Entegris Malaysia SDN Bhd")).toBeNull();
  });

  // "Fireworks AI" vs the board's "Fireworks" is a real disagreement, not a
  // typo, and the shorter one is not obviously better. Dropping a token would
  // rename a company the user recognises, so a difference of whole WORDS is
  // left alone.
  test("a dropped or added word is a different name, not a misspelling", () => {
    expect(betterCompanyName("Fireworks AI", "Fireworks")).toBeNull();
    expect(betterCompanyName("Acme", "Acme Health")).toBeNull();
  });

  test("two genuinely different companies never merge", () => {
    expect(betterCompanyName("Databricks", "Snowflake")).toBeNull();
  });

  test("nothing to compare against changes nothing", () => {
    expect(betterCompanyName("Baseten", "")).toBeNull();
    expect(betterCompanyName("Baseten", null)).toBeNull();
  });

  test("an identical name is not a correction", () => {
    expect(betterCompanyName("Baseten", "Baseten")).toBeNull();
  });

  // A two-character slip is still one name; three is where a short name stops
  // being recognisable as the same word ("Clay" and "Cloud" are not typos of
  // each other).
  test("the edit budget scales with how much name there is", () => {
    expect(betterCompanyName("Clay", "Cloud")).toBeNull();
    expect(betterCompanyName("Smartsheeet", "Smartsheet")).toBe("Smartsheet");
  });
});
