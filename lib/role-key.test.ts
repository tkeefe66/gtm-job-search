import { describe, expect, test } from "vitest";
import {
  NORMALIZED_COMPANY_SQL,
  normalizeCompanyName,
  normalizeRoleKey,
  normalizeTitle,
} from "./role-key";

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

describe("NORMALIZED_COMPANY_SQL", () => {
  // These are guard tests, not behavioral ones: the expression runs in
  // Postgres and there is no database here, so what they pin is that it keeps
  // the four properties lib/ingest-roles.ts's dedupe lookup depends on. Each
  // one fails against a specific regression.

  test("does more than lower() — it collapses whitespace runs and trims", () => {
    // Fails against the previous `lower(company) = lower($1)` lookup, which
    // left "Big  Co" invisible to a crawl passing "Big Co" and re-inserted
    // every role as a duplicate.
    expect(NORMALIZED_COMPANY_SQL).toContain("lower(company)");
    expect(NORMALIZED_COMPANY_SQL).toContain("regexp_replace(");
    expect(NORMALIZED_COMPANY_SQL).toContain("btrim(");
  });

  test("names U+00A0 outright instead of trusting a locale-dependent class", () => {
    // normalizeCompanyName collapses U+00A0 because JS's \s does. Postgres's
    // whitespace classes may or may not, depending on locale/collation, so
    // the character is replaced explicitly. Fails if that replace is dropped
    // on the theory that '[[:space:]]' already covers it.
    expect(NORMALIZED_COMPANY_SQL).toContain("chr(160)");
  });

  test("uses the POSIX class, not a '\\s' literal TypeScript would eat", () => {
    // "\s" in a TS string literal is just "s" — that spelling would have
    // Postgres collapsing runs of the letter s. The POSIX class needs no
    // backslash, so it cannot be corrupted that way.
    expect(NORMALIZED_COMPANY_SQL).toContain("'[[:space:]]+'");
    expect(NORMALIZED_COMPANY_SQL).not.toContain("'s+'");
  });

  test("replaces globally, not just the first whitespace run", () => {
    expect(NORMALIZED_COMPANY_SQL).toContain("'g'");
  });

  test("the parameter side collapses exactly what the expression targets", () => {
    // The value bound to $1 is normalizeCompanyName(company). All three
    // transforms the SQL performs must already have been applied to it, or
    // the two sides cannot meet. Built with an explicit \xa0 escape.
    expect(normalizeCompanyName("  Big" + "\xa0" + " CO  ")).toBe("big co");
  });
});
