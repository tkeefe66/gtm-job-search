import { describe, expect, test } from "vitest";
import { resolveCareersUrlWrite } from "./careers-url-precedence";

describe("resolveCareersUrlWrite", () => {
  test("existing non-empty wins over a different non-empty guess", () => {
    // Catches an implementation that always writes the guess (the original
    // bug: Discover's re-watch clobbered a hand-corrected URL).
    expect(
      resolveCareersUrlWrite("https://hand-fixed.example/careers", "https://guess.example/jobs")
    ).toBeUndefined();
  });

  test("existing non-empty wins even when the guess is empty", () => {
    expect(resolveCareersUrlWrite("https://hand-fixed.example/careers", "")).toBeUndefined();
  });

  test("existing null yields to a non-empty guess", () => {
    // Catches an implementation that always preserves existing (never
    // resolves a URL for a brand-new company).
    expect(resolveCareersUrlWrite(null, "https://guess.example/jobs")).toBe(
      "https://guess.example/jobs"
    );
  });

  test("existing empty string yields to a non-empty guess", () => {
    expect(resolveCareersUrlWrite("", "https://guess.example/jobs")).toBe(
      "https://guess.example/jobs"
    );
  });

  test("existing whitespace-only is treated as empty and yields to the guess", () => {
    expect(resolveCareersUrlWrite("   ", "https://guess.example/jobs")).toBe(
      "https://guess.example/jobs"
    );
  });

  test("guess is trimmed before being returned", () => {
    expect(resolveCareersUrlWrite(null, "  https://guess.example/jobs  ")).toBe(
      "https://guess.example/jobs"
    );
  });

  test("both empty stays empty (undefined — no column write)", () => {
    // Catches an implementation that writes "" instead of omitting the key,
    // which would blank out the column via the upsert builder.
    expect(resolveCareersUrlWrite(null, undefined)).toBeUndefined();
    expect(resolveCareersUrlWrite("", "")).toBeUndefined();
  });
});
