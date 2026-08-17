import { describe, expect, test } from "vitest";
import { SEARCH_SUBJECT, STACK_FAMILY_INTRO, roleSearchSystem } from "./search-criteria";

describe("the search subject renders into its sites", () => {
  test("roleSearchSystem reproduces today's sentence exactly", () => {
    expect(roleSearchSystem(SEARCH_SUBJECT)).toBe(
      "You are a recruiting researcher specializing in go-to-market and revenue operations roles. Return ONLY valid JSON, no markdown, no preamble."
    );
  });

  test("a different subject reaches the sentence", () => {
    expect(roleSearchSystem("mechanical engineering")).toContain(
      "specializing in mechanical engineering roles"
    );
    expect(roleSearchSystem("mechanical engineering")).not.toContain("go-to-market");
  });

  test("the stack intro keeps the job titles it names", () => {
    // The subject is the opening of a longer sentence. If a future change
    // extracts only the subject, these three titles are left behind pointing at
    // the wrong career.
    expect(STACK_FAMILY_INTRO).toContain("Business Systems Manager");
    expect(STACK_FAMILY_INTRO).toContain("Growth Systems Lead");
    expect(STACK_FAMILY_INTRO).toContain("Revenue Systems");
    expect(STACK_FAMILY_INTRO).toContain("not just the obvious RevOps titles");
  });

  test("the stack intro is byte-identical to today's FAMILY_INTRO.stack text", () => {
    // Pins the whole sentence, not just the fragments above — catches a
    // dropped word, a doubled space, or a mangled em dash anywhere in it.
    expect(STACK_FAMILY_INTRO).toBe(
      "Search job boards and company careers pages for currently-open go-to-market / revenue operations roles that mention these tools. Titles vary — include Business Systems Manager, Growth Systems Lead, Revenue Systems, and similar, not just the obvious RevOps titles. Use these searches"
    );
  });
});
