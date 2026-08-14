import { describe, expect, test } from "vitest";
import { resolveCareersUrlWrite } from "./careers-url-precedence";

describe("resolveCareersUrlWrite", () => {
  test("existing non-empty wins over a different non-empty guess", () => {
    // Catches an implementation that always writes the guess (the original
    // bug: Discover's re-watch clobbered a hand-corrected URL).
    expect(
      resolveCareersUrlWrite({ known: true, url: "https://hand-fixed.example/careers" }, "https://guess.example/jobs")
    ).toBeUndefined();
  });

  test("existing non-empty wins even when the guess is empty", () => {
    expect(resolveCareersUrlWrite({ known: true, url: "https://hand-fixed.example/careers" }, "")).toBeUndefined();
  });

  test("existing null yields to a non-empty guess", () => {
    // Catches an implementation that always preserves existing (never
    // resolves a URL for a brand-new company).
    expect(resolveCareersUrlWrite({ known: true, url: null }, "https://guess.example/jobs")).toBe(
      "https://guess.example/jobs"
    );
  });

  test("existing empty string yields to a non-empty guess", () => {
    expect(resolveCareersUrlWrite({ known: true, url: "" }, "https://guess.example/jobs")).toBe(
      "https://guess.example/jobs"
    );
  });

  test("existing whitespace-only is treated as empty and yields to the guess", () => {
    expect(resolveCareersUrlWrite({ known: true, url: "   " }, "https://guess.example/jobs")).toBe(
      "https://guess.example/jobs"
    );
  });

  test("guess is trimmed before being returned", () => {
    expect(resolveCareersUrlWrite({ known: true, url: null }, "  https://guess.example/jobs  ")).toBe(
      "https://guess.example/jobs"
    );
  });

  test("both empty stays empty (undefined — no column write)", () => {
    // Catches an implementation that writes "" instead of omitting the key,
    // which would blank out the column via the upsert builder.
    expect(resolveCareersUrlWrite({ known: true, url: null }, undefined)).toBeUndefined();
    expect(resolveCareersUrlWrite({ known: true, url: "" }, "")).toBeUndefined();
  });
});

describe("resolveCareersUrlWrite when the stored value is UNKNOWN", () => {
  // Rule 0. The watchlist read that produces `existing` can fail, and it used
  // to fail soft to null — indistinguishable from "nothing stored" — which
  // walked into rule 2 and let Discover's guess overwrite a hand-typed URL,
  // resetting crawl_method / last_crawl_status / last_crawl_error with it.
  // Permanent, and manual to undo.

  test("a guess NEVER wins against an unknown stored value", () => {
    // The regression, stated directly. Against the old signature this call
    // site passed `null` and returned the guess.
    expect(resolveCareersUrlWrite({ known: false }, "https://guess.example/jobs")).toBeUndefined();
  });

  test("unknown yields no write even when the guess looks confident", () => {
    expect(
      resolveCareersUrlWrite({ known: false }, "  https://very-confident.example/careers  ")
    ).toBeUndefined();
  });

  test("unknown with no guess is also no write", () => {
    expect(resolveCareersUrlWrite({ known: false }, null)).toBeUndefined();
    expect(resolveCareersUrlWrite({ known: false }, undefined)).toBeUndefined();
    expect(resolveCareersUrlWrite({ known: false }, "")).toBeUndefined();
  });

  test("KNOWN-but-null still yields to a guess — unknown is not just a rename of null", () => {
    // The distinction the union exists to make. If `known: false` were merely
    // spelled differently from `{ known: true, url: null }`, this pair would
    // return the same thing and the fix would be cosmetic.
    expect(resolveCareersUrlWrite({ known: true, url: null }, "https://guess.example/jobs")).toBe(
      "https://guess.example/jobs"
    );
    expect(resolveCareersUrlWrite({ known: false }, "https://guess.example/jobs")).toBeUndefined();
  });
});
