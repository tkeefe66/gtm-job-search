import { describe, expect, test } from "vitest";

import { boardTrust, rolesFromBoard, type BoardResolution } from "./board-source";

// Step 4's core safety rule. A guessed slug today produces a bad LINK on a row
// that already exists, and every consumer hedges accordingly. Under enumeration
// a guessed slug CREATES ROWS — a stranger's postings under your company's
// name, live so they pass the URL check, scored, billed, and stored. Both
// reviewers flagged this as a new failure class, not a widening of an old one.
describe("what a resolution is allowed to do", () => {
  const read: BoardResolution = { vendor: "greenhouse", slug: "anthropic", source: "read" };
  const guessed: BoardResolution = { vendor: "greenhouse", slug: "anthropic", source: "guessed" };

  test("a slug READ out of an employer's own link may source roles", () => {
    expect(boardTrust(read, "Anthropic", [])).toBe("source");
  });

  // The corroborator: Greenhouse publishes the employer's own name on every
  // posting, so a guess can be checked against the company we asked about.
  test("a guessed slug the board's own name confirms may source roles", () => {
    expect(boardTrust(guessed, "Anthropic", ["Anthropic"])).toBe("source");
  });

  test("a guessed slug the board CONTRADICTS is refused outright", () => {
    expect(boardTrust(guessed, "Corning", ["Corning Natural Gas"])).toBe("refuse");
  });

  // Ashby, Lever and Workable publish no employer name, so a guess there has
  // nothing to check against — and "the board is not empty" only proves the
  // vendor is honest, never that the board is this company's.
  test("a guessed slug with NO corroborator may not source roles", () => {
    expect(boardTrust({ ...guessed, vendor: "ashby" }, "Anthropic", [])).toBe("refuse");
  });

  test("a read slug needs no corroboration, because it was never a guess", () => {
    expect(boardTrust({ ...read, vendor: "ashby" }, "Anthropic", [])).toBe("source");
  });

  // Legal suffixes and casing are not disagreement — companyIdentityKey's job.
  test("the same employer spelled differently still corroborates", () => {
    expect(boardTrust(guessed, "Anthropic", ["Anthropic, Inc."])).toBe("source");
  });
});

describe("turning a board listing into roles", () => {
  const posting = (title: string, url = "https://x/1") => ({ title, url });

  test("every posting keeps the board's own title and URL", () => {
    const roles = rolesFromBoard([posting("RevOps Manager")], ["revops"]);

    expect(roles[0]).toMatchObject({
      role_title: "RevOps Manager",
      job_url: "https://x/1",
    });
  });

  // Filtering happens BEFORE ingest, because ingest fans out unbounded
  // Promise.alls for liveness checks and scoring — a 400-role board would issue
  // 400 concurrent requests inside a 300s request.
  test("only titles matching what the user searches for are kept", () => {
    const roles = rolesFromBoard(
      [posting("RevOps Manager"), posting("Line Cook"), posting("Head of Revenue Operations")],
      ["RevOps Lead", "Director of Revenue Operations"]
    );

    expect(roles.map((r) => r.role_title)).toEqual(["RevOps Manager", "Head of Revenue Operations"]);
  });

  // MEASURED against a real 89-posting board on 2026-09-07: matching a
  // configured title as a SUBSTRING found nothing at all, because the user
  // configures phrases ("Director of Revenue Operations") and boards publish
  // job titles ("Marketing Platform Operations Manager"). The rule is instead:
  // every meaningful word of some configured title appears somewhere in the
  // board's title, in any order.
  test("a board title matches when it carries the configured title's words", () => {
    const roles = rolesFromBoard(
      [posting("Marketing Platform Operations Manager"), posting("Senior Manager, RevOps (Remote)")],
      ["Head of Marketing Operations", "RevOps Lead"]
    );

    expect(roles).toHaveLength(2);
  });

  // Seniority words are dropped from the configured title before matching:
  // "Director of Revenue Operations" is a search for revenue operations work,
  // not specifically for a Director, and the fit score is what judges level.
  test("seniority wording does not have to line up", () => {
    expect(
      rolesFromBoard([posting("Revenue Operations Manager")], ["Head of Revenue Operations"])
    ).toHaveLength(1);
  });

  // The other direction: a title sharing ONE word is not a match, or every
  // "Operations" role on a board comes through.
  test("one shared word is not a match", () => {
    expect(
      rolesFromBoard([posting("Warehouse Operations Lead")], ["Director of Revenue Operations"])
    ).toEqual([]);
  });

  test("no terms configured keeps everything rather than nothing", () => {
    expect(rolesFromBoard([posting("Line Cook")], [])).toHaveLength(1);
  });

  test("a board with nothing on it produces no roles and no error", () => {
    expect(rolesFromBoard([], ["revops"])).toEqual([]);
  });
});
