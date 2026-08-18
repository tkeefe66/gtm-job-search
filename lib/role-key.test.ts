import { describe, expect, test } from "vitest";
import {
  NORMALIZED_COMPANY_SQL,
  companyIdentityKey,
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

describe("companyIdentityKey", () => {
  // The case this function exists for. Probe A returned RTX under both
  // spellings; normalizeCompanyName reports them as two keys, so Discover
  // rendered two cards for one employer.
  test("merges a parenthetical alias written in either order", () => {
    expect(companyIdentityKey("RTX (Raytheon)")).toBe(
      companyIdentityKey("Raytheon (RTX)")
    );
  });

  // Pins that this is NOT normalizeCompanyName wearing a different name: an
  // implementation that delegated straight to it would fail this and the
  // test above, which is the whole point of having both.
  test("is not merely the normalizer under another name", () => {
    expect(companyIdentityKey("RTX (Raytheon)")).not.toBe(
      normalizeCompanyName("RTX (Raytheon)")
    );
  });

  test("ignores legal-form suffixes and their punctuation", () => {
    expect(companyIdentityKey("Acme Inc.")).toBe(companyIdentityKey("Acme"));
    expect(companyIdentityKey("Acme, LLC")).toBe(companyIdentityKey("Acme"));
  });

  // Without the `meaningful.length > 0` fallback this returns "" and every
  // all-suffix name collapses onto one card.
  test("keeps the tokens of a name made only of legal-form words", () => {
    expect(companyIdentityKey("Ltd")).toBe("ltd");
    expect(companyIdentityKey("Ltd")).not.toBe(companyIdentityKey("Inc"));
  });

  // Without the punctuation-only fallback this also returns "", merging every
  // junk-named row into a single card.
  test("falls back to the normalized name when there are no word tokens", () => {
    expect(companyIdentityKey("—")).toBe("—");
    expect(companyIdentityKey("—")).not.toBe(companyIdentityKey("+++"));
  });

  test("collapses a token repeated in the name", () => {
    expect(companyIdentityKey("RTX (RTX)")).toBe(companyIdentityKey("RTX"));
  });

  test("does not merge employers that merely share a word", () => {
    expect(companyIdentityKey("Acme Health")).not.toBe(
      companyIdentityKey("Acme Wealth")
    );
  });

  // Pins the \p{L} class. An ASCII-only [a-z0-9] split truncates "Nestlé" to
  // "nestl", which would make this pass by accident in the wrong direction.
  test("keeps non-ASCII letters rather than truncating at them", () => {
    expect(companyIdentityKey("Nestlé")).toBe("nestlé");
    expect(companyIdentityKey("Nestlé")).not.toBe(companyIdentityKey("Nestl"));
  });

  test("is order-independent and whitespace-insensitive", () => {
    expect(companyIdentityKey("  Alpha  Beta ")).toBe(
      companyIdentityKey("Beta Alpha")
    );
  });
});
