import { describe, expect, test } from "vitest";
import { cacheWriteWarning, countPhrase } from "./cache-write-warning";
import { UNDESCRIBED_DB_ERROR } from "./write-failure";

describe("countPhrase", () => {
  test("pluralizes everything except exactly one", () => {
    expect(countPhrase(1, "role")).toBe("1 role");
    expect(countPhrase(0, "role")).toBe("0 roles");
    expect(countPhrase(12, "role")).toBe("12 roles");
    expect(countPhrase(1, "startup")).toBe("1 startup");
    expect(countPhrase(2, "startup")).toBe("2 startups");
  });
});

describe("cacheWriteWarning", () => {
  const base = { produced: "Found 12 roles", table: "discovered_roles" };

  test("names the schema command — the fix for the most likely cause", () => {
    // A deploy without `node db/apply-schema.mjs` is the dominant real cause:
    // the table simply does not exist. That is a statement-level error with a
    // perfectly good message that all four call sites were discarding. If this
    // string is ever dropped from the message, the warning stops being
    // actionable and becomes decoration.
    const warning = cacheWriteWarning({ ...base, error: 'relation "discovered_roles" does not exist' });
    expect(warning).toContain("node db/apply-schema.mjs");
    expect(warning).toContain("DATABASE_URL=");
  });

  test("names the table in BOTH the failure and the fix", () => {
    const warning = cacheWriteWarning({ ...base, error: "boom" });
    // Two occurrences, not one: "saving to the X cache failed" and "if the X
    // table is missing". A message that names it once leaves the user
    // guessing which table to check.
    expect(warning.split("discovered_roles")).toHaveLength(3);
  });

  test("says the cost of ignoring it", () => {
    // The whole reason this is surfaced rather than logged: the money.
    const warning = cacheWriteWarning({ ...base, error: "boom" });
    expect(warning).toContain("re-billed");
  });

  test("an EMPTY driver message gets the stand-in, not a dangling dash", () => {
    // The empty-message class, at the point of display. Without substitution
    // the sentence reads "... failed — . The results are live", which tells
    // the user nothing about why.
    const warning = cacheWriteWarning({ ...base, error: "" });
    expect(warning).toContain(UNDESCRIBED_DB_ERROR);
    expect(warning).not.toContain("failed — .");
  });

  test("a described failure is quoted verbatim, without the stand-in", () => {
    const warning = cacheWriteWarning({ ...base, error: "read-only transaction" });
    expect(warning).toContain("read-only transaction");
    expect(warning).not.toContain(UNDESCRIBED_DB_ERROR);
  });

  test("the produced clause leads, so the user reads the good news first", () => {
    // The results were paid for and are on screen; a message that opens with
    // the failure reads as though they were lost.
    expect(cacheWriteWarning({ ...base, error: "boom" }).startsWith("Found 12 roles,")).toBe(
      true
    );
  });
});
