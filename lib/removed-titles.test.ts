import { describe, expect, test } from "vitest";
import {
  CRAWL_TITLE_MATCH_SQL,
  removedTitles,
  removedTitlesWarning,
  titleMatchPatterns,
} from "./removed-titles";

describe("removedTitles", () => {
  test("returns nothing when the draft keeps everything", () => {
    expect(removedTitles(["A", "B"], ["A", "B"])).toEqual([]);
  });

  test("returns only the entries the draft dropped, in saved order", () => {
    expect(removedTitles(["A", "B", "C"], ["B"])).toEqual(["A", "C"]);
  });

  test("an addition is not a removal", () => {
    expect(removedTitles(["A"], ["A", "B", "C"])).toEqual([]);
  });

  test("re-casing or re-spacing a title is an edit, not a removal", () => {
    const out = removedTitles(["RevOps Lead"], ["  revops   lead "]);
    expect(out).toEqual([]);
  });

  test("a rename counts the old title as removed, with its saved spelling", () => {
    expect(removedTitles(["RevOps Lead"], ["RevOps Manager"])).toEqual(["RevOps Lead"]);
  });

  test("an emptied draft removes every saved title", () => {
    const saved = ["A", "B", "C"];
    const out = removedTitles(saved, []);
    expect(out).toHaveLength(3);
    expect(out).toEqual(saved);
  });

  test("blank draft lines do not keep anything alive", () => {
    // The form hands this function a split() of a textarea, so blank lines are
    // routine. If they survived normalization they would be compared as "" and
    // keep nothing — but a bug that kept them as whitespace keys would.
    expect(removedTitles(["A"], ["", "   ", "\n"])).toEqual(["A"]);
  });
});

describe("titleMatchPatterns", () => {
  test("wraps each title in substring wildcards", () => {
    expect(titleMatchPatterns(["GTM Engineer"])).toEqual(["%GTM Engineer%"]);
  });

  test("escapes the LIKE wildcards so a title cannot match everything", () => {
    expect(titleMatchPatterns(["100% Remote"])).toEqual(["%100\\% Remote%"]);
    expect(titleMatchPatterns(["Head_of_Ops"])).toEqual(["%Head\\_of\\_Ops%"]);
  });

  test("escapes a backslash exactly once", () => {
    // A second .replace pass over the output would turn this into four
    // backslashes and stop matching the row it is looking for.
    expect(titleMatchPatterns(["A\\B"])).toEqual(["%A\\\\B%"]);
  });

  test("normalizes and de-duplicates before building patterns", () => {
    const out = titleMatchPatterns([" GTM  Engineer ", "gtm engineer", ""]);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe("%GTM Engineer%");
  });

  test("an empty list produces no patterns", () => {
    // The action short-circuits on this: `ilike any('{}')` matches no rows,
    // but spending a query to learn that is pointless.
    expect(titleMatchPatterns([])).toEqual([]);
  });
});

describe("CRAWL_TITLE_MATCH_SQL", () => {
  test("counts only crawler-found rows", () => {
    expect(CRAWL_TITLE_MATCH_SQL).toContain("source = 'Crawl'");
  });

  test("counts only rows the user has not acted on", () => {
    expect(CRAWL_TITLE_MATCH_SQL).toContain("status = 'New'");
  });

  test("matches titles by pattern against an array parameter", () => {
    expect(CRAWL_TITLE_MATCH_SQL).toContain("role_title ilike any($1::text[])");
  });

  test("is a count, aliased to the column the action reads", () => {
    expect(CRAWL_TITLE_MATCH_SQL).toContain("count(*) n");
  });
});

describe("removedTitlesWarning", () => {
  test("names the count and both consequences", () => {
    expect(removedTitlesWarning(7)).toBe(
      "7 tracked roles match titles you are removing. They stay on /roles, and " +
        "the crawler will stop monitoring them."
    );
  });

  test("reads correctly for a single role", () => {
    expect(removedTitlesWarning(1)).toContain("1 tracked role matches");
    expect(removedTitlesWarning(1)).not.toContain("roles match ");
  });

  test("zero is still stated as a number", () => {
    // "No tracked roles are affected" is a different, weaker sentence. The
    // spec asks for a count, and 0 is a count.
    expect(removedTitlesWarning(0)).toContain("0 tracked roles match");
  });
});
