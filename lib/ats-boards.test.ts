import { describe, expect, test } from "vitest";
import { boardApiUrl, boardPageUrl, findPosting, parseBoard,
  parsePostingBody,
  postingBodyUrl,
} from "./ats-boards";

describe("parseBoard — absence vs emptiness", () => {
  test("a real board with no roles is [], an absent board is null", () => {
    // The caller keeps probing other vendors on null and stops on []. Collapsing
    // the two would make "this company has no openings" indistinguishable from
    // "this company isn't on Greenhouse".
    expect(parseBoard("greenhouse", { jobs: [] })).toEqual([]);
    expect(parseBoard("greenhouse", { error: "not found" })).toBeNull();
  });

  test("an error PAYLOAD is not a board, whatever status carried it", () => {
    // Lever's body for a missing board. It arrives with a 404 today, so the
    // transport already rejects it — this pins the second gate, which is what
    // catches a vendor that sends an error payload under a success status.
    // SmartRecruiters does exactly that (200 + an empty envelope for companies
    // that do not exist), which is why it is not in BOARD_VENDORS.
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

  test("workable uses title + url, falling back to shortlink", () => {
    expect(
      parseBoard("workable", {
        name: "Actionstep",
        jobs: [
          { title: "Account Executive", url: "https://apply.workable.com/j/70F75EA6A8" },
          { title: "Finance Manager", shortlink: "https://apply.workable.com/j/AF7E2AAF6C" },
        ],
      })
    ).toEqual([
      { title: "Account Executive", url: "https://apply.workable.com/j/70F75EA6A8" },
      { title: "Finance Manager", url: "https://apply.workable.com/j/AF7E2AAF6C" },
    ]);
  });

  test("breezy is a bare array using name + url", () => {
    expect(
      parseBoard("breezy", [
        { name: "Business Development Representative", url: "https://assignar.breezy.hr/p/7ff0" },
      ])
    ).toEqual([
      { title: "Business Development Representative", url: "https://assignar.breezy.hr/p/7ff0" },
    ]);
    expect(parseBoard("breezy", { jobs: [] })).toBeNull();
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

describe("findPosting", () => {
  const board = [
    { title: "Head of Revenue Operations", url: "https://x.com/1" },
    { title: "GTM Engineer", url: "https://x.com/2" },
    { title: "GTM Engineering Manager", url: "https://x.com/3" },
  ];
  const url = (t: string, b = board) => {
    const m = findPosting(b, t);
    return m.kind === "posting" ? m.posting.url : m.kind;
  };

  test("matches on the title, ignoring case and punctuation", () => {
    expect(url("head of revenue operations")).toBe("https://x.com/1");
    expect(url("Head of Revenue Operations!")).toBe("https://x.com/1");
  });

  test("an exact match wins even when others contain the title", () => {
    // "GTM Engineer" is a substring of "GTM Engineering Manager"; the exact
    // hit must not be lost to the ambiguity rule below.
    expect(url("GTM Engineer")).toBe("https://x.com/2");
  });

  test("a longer posting title still matches a shorter stored one", () => {
    const regional = [{ title: "Head of Revenue Operations, EMEA", url: "https://x.com/9" }];
    expect(url("Head of Revenue Operations", regional)).toBe("https://x.com/9");
  });

  test("several candidates are AMBIGUOUS, which never closes a role", () => {
    // The distinction that matters: ambiguous means "the role may well be
    // live, we just can't tell which posting it is". Reporting absent here
    // would close a live role over a wording difference.
    const many = [
      { title: "GTM Engineer, Platform", url: "https://x.com/4" },
      { title: "GTM Engineer, Growth", url: "https://x.com/5" },
    ];
    expect(findPosting(many, "GTM Engineer")).toEqual({ kind: "ambiguous" });
  });

  test("duplicate exact titles are ambiguous too", () => {
    const dupes = [
      { title: "RevOps Lead", url: "https://x.com/6" },
      { title: "RevOps Lead", url: "https://x.com/7" },
    ];
    expect(findPosting(dupes, "RevOps Lead")).toEqual({ kind: "ambiguous" });
  });

  test("nothing resembling the title is ABSENT — the only closable outcome", () => {
    expect(findPosting(board, "Chief Financial Officer")).toEqual({ kind: "absent" });
  });

  test("a board with no postings at all is EMPTY, never absent", () => {
    // Asseti keeps an empty Breezy board while hiring eight roles through
    // Workable. Calling this absent would close live roles on the strength of
    // an abandoned board, so the caller keeps probing other vendors instead.
    expect(findPosting([], "Head of Revenue Operations")).toEqual({ kind: "empty" });
  });

  test("one posting is enough to make the board trustworthy", () => {
    // The live Invoca case: its board carried a lone "join our talent
    // community" entry and nothing else, which IS a definitive answer.
    const placeholder = [{ title: "Join Our Talent Community", url: "https://x.com/tc" }];
    expect(findPosting(placeholder, "Sr. GTM AI Architect")).toEqual({ kind: "absent" });
  });

  test("an empty title is ambiguous, never absent", () => {
    // We cannot answer the question, and answering "absent" would close the
    // role on the strength of having nothing to compare.
    expect(findPosting(board, "  ")).toEqual({ kind: "ambiguous" });
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

// Coverage, measured rather than assumed: a real pass over 60 rows skipped 21
// of them as JS shells, and the two vendors behind most of that queue
// (Greenhouse 19 rows, Ashby 8) both publish the posting's own text through
// the SAME honest APIs this file already reads for link health. Reading the
// body there is not the "no ATS APIs for DISCOVERY" rule being bent — nothing
// here finds a role; it reads a role we already have.
describe("reading one posting's body off the board API", () => {
  test("Greenhouse needs a per-posting URL, built from the id in the stored link", () => {
    expect(postingBodyUrl("greenhouse", "anthropic", "4461450008")).toBe(
      "https://boards-api.greenhouse.io/v1/boards/anthropic/jobs/4461450008"
    );
  });

  // Ashby's board list already carries descriptionPlain for every posting, so
  // asking for one costs NOTHING beyond the board fetch link health already
  // makes and caches. A per-posting URL would be a second call for data we
  // have.
  test("Ashby needs no second call", () => {
    expect(postingBodyUrl("ashby", "baseten", "abc")).toBeNull();
  });

  test("a vendor whose body shape is unverified is not guessed at", () => {
    expect(postingBodyUrl("breezy", "acme", "1")).toBeNull();
    expect(parsePostingBody("breezy", "1", { description: "anything" })).toBeNull();
  });

  test("Greenhouse's content is HTML and comes back as text", () => {
    const body = parsePostingBody("greenhouse", "6510547003", {
      content: "&lt;p&gt;Requires 5 years of SQL.&lt;/p&gt;",
      departments: [{ name: "Revenue Operations" }],
    });

    expect(body?.text).toContain("Requires 5 years of SQL.");
    expect(body?.text).not.toContain("<p>");
    expect(body?.department).toBe("Revenue Operations");
  });

  test("Ashby's body is found by posting id inside the board payload", () => {
    const board = {
      jobs: [
        { id: "other", descriptionPlain: "Not this one", department: "Sales" },
        { id: "wanted", descriptionPlain: "Requires 5 years of SQL.", department: "RevOps" },
      ],
    };

    const body = parsePostingBody("ashby", "wanted", board);

    expect(body?.text).toBe("Requires 5 years of SQL.");
    expect(body?.department).toBe("RevOps");
  });

  // The same rule every other parser in this file follows: a shape we do not
  // recognise is null — "we could not read it" — never an empty string that a
  // caller would store as "this posting says nothing".
  test("an unrecognised payload is null, not empty text", () => {
    expect(parsePostingBody("greenhouse", "1", { status: 404, error: "Job not found" })).toBeNull();
    expect(parsePostingBody("ashby", "missing", { jobs: [] })).toBeNull();
    expect(parsePostingBody("greenhouse", "1", null)).toBeNull();
  });

  test("a posting whose body is blank is null too — there is nothing to store", () => {
    expect(parsePostingBody("greenhouse", "1", { content: "   " })).toBeNull();
  });
});

// Probed 2026-09-07, each against the standard BOARD_VENDORS demands: a real
// board, a nonsense slug, and (where the vendor has a per-posting endpoint) a
// nonsense posting id on a real board. Lever and Workable answered honestly;
// Breezy did not and is excluded.
describe("the vendors whose bodies were probed, and the one that failed", () => {
  test("Lever's board payload carries every posting's own text", () => {
    const board = [
      { id: "other", descriptionPlain: "Not this one" },
      {
        id: "wanted",
        descriptionPlain: "You will own the revenue stack.",
        lists: [{ text: "Requirements", content: "<li>5 years of SQL</li>" }],
        department: "Revenue Operations",
      },
    ];

    const body = parsePostingBody("lever", "wanted", board);

    expect(body?.text).toContain("You will own the revenue stack.");
    // The `lists` are where Lever puts the requirement bullets — dropping them
    // would hand the model the blurb and none of what the posting asks for.
    expect(body?.text).toContain("Requirements");
    expect(body?.text).toContain("5 years of SQL");
  });

  test("Workable needs a per-posting call, keyed by the shortcode in the link", () => {
    expect(postingBodyUrl("workable", "asseti", "5DC414FD1C")).toBe(
      "https://apply.workable.com/api/v1/accounts/asseti/jobs/5DC414FD1C"
    );
  });

  test("Workable keeps requirements in their own field, and it must not be dropped", () => {
    const body = parsePostingBody("workable", "5DC414FD1C", {
      description: "<p>About the company</p>",
      requirements: "<p>What you will bring</p><ul><li>5 years of SQL</li></ul>",
      department: "Sales",
    });

    expect(body?.text).toContain("About the company");
    expect(body?.text).toContain("5 years of SQL");
    expect(body?.department).toBe("Sales");
  });

  // Breezy's board list carries no description at all, and its per-posting
  // JSON answers 302 rather than a body — a redirect is not an honest answer.
  // Same treatment as SmartRecruiters and Workday: excluded rather than
  // guessed at.
  test("Breezy is not read, because nothing about it was verifiable", () => {
    expect(postingBodyUrl("breezy", "acme", "1")).toBeNull();
    expect(parsePostingBody("breezy", "1", { description: "anything" })).toBeNull();
  });
});
