import { describe, expect, test } from "vitest";
import { boardApiUrl, boardPageUrl, matchPosting, parseBoard } from "./ats-boards";

describe("parseBoard — absence vs emptiness", () => {
  test("a real board with no roles is [], an absent board is null", () => {
    // The caller keeps probing other vendors on null and stops on []. Collapsing
    // the two would make "this company has no openings" indistinguishable from
    // "this company isn't on Greenhouse".
    expect(parseBoard("greenhouse", { jobs: [] })).toEqual([]);
    expect(parseBoard("greenhouse", { error: "not found" })).toBeNull();
  });

  test("Lever's soft 404 is caught by SHAPE, not by status", () => {
    // Verified live: a missing Lever board answers HTTP 200 with this body.
    // A status-only check would treat it as a real, empty board and stop.
    expect(parseBoard("lever", { ok: false, error: "Document not found" })).toBeNull();
    expect(parseBoard("lever", [])).toEqual([]);
  });

  test("null and non-objects are never boards", () => {
    expect(parseBoard("ashby", null)).toBeNull();
    expect(parseBoard("ashby", "nope")).toBeNull();
    expect(parseBoard("greenhouse", undefined)).toBeNull();
  });
});

describe("parseBoard — vendor shapes", () => {
  test("greenhouse uses title + absolute_url", () => {
    expect(
      parseBoard("greenhouse", {
        jobs: [{ title: "Head of RevOps", absolute_url: "https://invoca.com/j/1" }],
      })
    ).toEqual([{ title: "Head of RevOps", url: "https://invoca.com/j/1" }]);
  });

  test("ashby uses title + jobUrl", () => {
    expect(
      parseBoard("ashby", {
        jobs: [{ title: "GTM Engineer", jobUrl: "https://jobs.ashbyhq.com/hex/1" }],
      })
    ).toEqual([{ title: "GTM Engineer", url: "https://jobs.ashbyhq.com/hex/1" }]);
  });

  test("ashby postings hidden from the board are dropped", () => {
    // isListed:false is a live posting the public board does not show, so a
    // candidate sent there lands on a page they cannot apply from.
    const board = parseBoard("ashby", {
      jobs: [
        { title: "Visible", jobUrl: "https://jobs.ashbyhq.com/x/1", isListed: true },
        { title: "Hidden", jobUrl: "https://jobs.ashbyhq.com/x/2", isListed: false },
      ],
    });
    expect(board).toEqual([{ title: "Visible", url: "https://jobs.ashbyhq.com/x/1" }]);
  });

  test("lever uses text + hostedUrl", () => {
    expect(
      parseBoard("lever", [{ text: "RevOps Lead", hostedUrl: "https://jobs.lever.co/atlan/1" }])
    ).toEqual([{ title: "RevOps Lead", url: "https://jobs.lever.co/atlan/1" }]);
  });

  test("entries missing a title or a URL are skipped, not half-built", () => {
    expect(
      parseBoard("greenhouse", {
        jobs: [
          { title: "Good", absolute_url: "https://x.com/1" },
          { title: "No URL" },
          { absolute_url: "https://x.com/2" },
          null,
          "garbage",
        ],
      })
    ).toEqual([{ title: "Good", url: "https://x.com/1" }]);
  });
});

describe("matchPosting", () => {
  const board = [
    { title: "Head of Revenue Operations", url: "https://x.com/1" },
    { title: "GTM Engineer", url: "https://x.com/2" },
    { title: "GTM Engineering Manager", url: "https://x.com/3" },
  ];

  test("matches on the title, ignoring case and punctuation", () => {
    expect(matchPosting(board, "head of revenue operations")?.url).toBe("https://x.com/1");
    expect(matchPosting(board, "Head of Revenue Operations!")?.url).toBe("https://x.com/1");
  });

  test("an exact match wins even when others contain the title", () => {
    // "GTM Engineer" is a substring of "GTM Engineering Manager"; the exact
    // hit must not be lost to the ambiguity rule below.
    expect(matchPosting(board, "GTM Engineer")?.url).toBe("https://x.com/2");
  });

  test("a longer posting title still matches a shorter stored one", () => {
    const regional = [{ title: "Head of Revenue Operations, EMEA", url: "https://x.com/9" }];
    expect(matchPosting(regional, "Head of Revenue Operations")?.url).toBe("https://x.com/9");
  });

  test("an ambiguous near-match returns nothing rather than guessing", () => {
    // Two plausible postings: sending the user to the wrong job is worse than
    // sending them to the board to look.
    const ambiguous = [
      { title: "GTM Engineer, Platform", url: "https://x.com/4" },
      { title: "GTM Engineer, Growth", url: "https://x.com/5" },
    ];
    expect(matchPosting(ambiguous, "GTM Engineer")).toBeNull();
  });

  test("no match at all is null", () => {
    expect(matchPosting(board, "Chief Financial Officer")).toBeNull();
    expect(matchPosting([], "Head of Revenue Operations")).toBeNull();
    expect(matchPosting(board, "  ")).toBeNull();
  });
});

describe("board URLs", () => {
  test("api and page URLs are built per vendor", () => {
    expect(boardApiUrl("greenhouse", "invoca")).toBe(
      "https://boards-api.greenhouse.io/v1/boards/invoca/jobs"
    );
    expect(boardApiUrl("ashby", "hex")).toBe("https://api.ashbyhq.com/posting-api/job-board/hex");
    expect(boardApiUrl("lever", "atlan")).toBe("https://api.lever.co/v0/postings/atlan?mode=json");
    expect(boardPageUrl("greenhouse", "invoca")).toBe("https://job-boards.greenhouse.io/invoca");
  });
});
