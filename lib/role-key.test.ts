import { describe, expect, test } from "vitest";
import { normalizeRoleKey, normalizeTitle } from "./role-key";

describe("normalizeTitle", () => {
  test("lowercases and collapses whitespace", () => {
    expect(normalizeTitle("  Director   of  RevOps ")).toBe("director of revops");
  });

  test("collapses non-breaking spaces like ordinary whitespace", () => {
    expect(normalizeTitle("Head\xa0of\xa0GTM")).toBe("head of gtm");
  });
});

describe("normalizeRoleKey", () => {
  test("same role in different casing produces the same key", () => {
    expect(normalizeRoleKey("Clay", "Head of RevOps")).toBe(
      normalizeRoleKey("clay", "HEAD OF REVOPS")
    );
  });

  test("same title at different companies produces different keys", () => {
    expect(normalizeRoleKey("Clay", "Head of RevOps")).not.toBe(
      normalizeRoleKey("Gong", "Head of RevOps")
    );
  });

  test("company and title cannot bleed across the separator", () => {
    // Without a separator, ("ab","c") and ("a","bc") would collide.
    expect(normalizeRoleKey("ab", "c")).not.toBe(normalizeRoleKey("a", "bc"));
  });
});
