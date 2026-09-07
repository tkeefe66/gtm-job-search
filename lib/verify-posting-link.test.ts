import { afterEach, describe, expect, test, vi } from "vitest";
import { newBoardCache, verifyPostingLink } from "./resolve-job-link";

// The board fetch is the only edge this function has, so it is the only thing
// stubbed. There was no fetch-stubbing precedent in lib/*.test.ts before this
// file — lib/crawler.test.ts says so explicitly and tests its pure decisions
// instead — so this uses vitest's own `stubGlobal` rather than inventing a
// seam in the production code.

const BASETEN_BOARD = "https://api.ashbyhq.com/posting-api/job-board/baseten";

/** The stored link from the real defect: a posting id Ashby no longer serves. */
const STALE = "https://jobs.ashbyhq.com/baseten/b621b620-85eb-4f73-8d77-e4ebd458b02d";
/** The live one, exactly as the board API spells it. */
const LIVE = "https://jobs.ashbyhq.com/baseten/5cd2f489-b9ee-428b-b252-94e83d55f107";

/** A captured-shape Ashby board envelope: `{ jobs: [{ title, jobUrl, isListed }] }`. */
function ashbyBoard(jobs: Array<{ title: string; jobUrl: string; isListed?: boolean }>) {
  return { jobs: jobs.map((j) => ({ isListed: true, ...j })) };
}

function stubBoard(body: unknown, ok = true) {
  const fetchMock = vi.fn(async () => ({ ok, json: async () => body }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("verifyPostingLink", () => {
  // Mutation this catches: comparing the stored URL to the board's postings by
  // raw string equality. A cosmetic difference would then report a healthy link
  // as missing and relink it — or, worse, call it absent.
  test("a stored URL the board lists is `listed`", async () => {
    stubBoard(ashbyBoard([{ title: "GTM Engineer", jobUrl: LIVE }]));

    const res = await verifyPostingLink(LIVE, "GTM Engineer");

    expect(res.kind).toBe("listed");
  });

  test("matching tolerates www, a trailing slash and a query string", async () => {
    stubBoard(ashbyBoard([{ title: "GTM Engineer", jobUrl: LIVE }]));

    const res = await verifyPostingLink(`${LIVE}/?utm_source=x`, "GTM Engineer");

    expect(res.kind).toBe("listed");
  });

  // The regression test for the actual defect. Mutation this catches: the
  // `=== "aggregator"` early return this whole change removes — under it the
  // board is never consulted and this returns nothing to act on.
  test("a stale posting id with exactly one title match relinks to the board's URL", async () => {
    const fetchMock = stubBoard(ashbyBoard([{ title: "GTM Engineer", jobUrl: LIVE }]));

    const res = await verifyPostingLink(STALE, "GTM Engineer");

    expect(res).toEqual({ kind: "relink", vendor: "ashby", slug: "baseten", url: LIVE });
    // The slug was READ out of the stored URL, not guessed from a company name:
    // exactly one board, and it is this employer's own.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(BASETEN_BOARD);
  });

  // Mutation this catches: treating `findPosting`'s `ambiguous` as a relink by
  // taking the first candidate. That sends the user to the wrong req.
  test("a stale id whose title matches two postings is `unclear`/ambiguous", async () => {
    stubBoard(
      ashbyBoard([
        { title: "GTM Engineer", jobUrl: LIVE },
        { title: "GTM Engineer", jobUrl: "https://jobs.ashbyhq.com/baseten/other-id" },
      ])
    );

    const res = await verifyPostingLink(STALE, "GTM Engineer");

    expect(res).toEqual({
      kind: "unclear",
      vendor: "ashby",
      slug: "baseten",
      url: "https://jobs.ashbyhq.com/baseten",
      reason: "ambiguous",
    });
  });

  // Mutation this catches: folding `empty` into `absent`. An empty board never
  // concludes anything anywhere else in this file, and must not start here.
  test("a board that lists nothing is `unclear`/empty, never absent", async () => {
    stubBoard(ashbyBoard([]));

    const res = await verifyPostingLink(STALE, "GTM Engineer");

    expect(res).toEqual({
      kind: "unclear",
      vendor: "ashby",
      slug: "baseten",
      url: "https://jobs.ashbyhq.com/baseten",
      reason: "empty",
    });
  });

  // Mutation this catches: reading a failed fetch as an empty board, i.e.
  // dropping `if (postings === null)` and letting `findPosting([])` answer.
  // A timeout would then be indistinguishable from a board with no jobs.
  test("a board that cannot be read is `unreachable`", async () => {
    stubBoard(ashbyBoard([{ title: "GTM Engineer", jobUrl: LIVE }]), false);

    expect((await verifyPostingLink(STALE, "GTM Engineer")).kind).toBe("unreachable");
  });

  test("a fetch that throws is `unreachable` too", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      })
    );

    expect((await verifyPostingLink(STALE, "GTM Engineer")).kind).toBe("unreachable");
  });

  // Mutation this catches: keeping the board's postings but not requiring the
  // title to match, so any board with jobs on it produces a relink.
  test("a board with jobs but nothing resembling the title is `absent`", async () => {
    stubBoard(ashbyBoard([{ title: "Staff Backend Engineer", jobUrl: LIVE }]));

    const res = await verifyPostingLink(STALE, "GTM Engineer");

    expect(res).toEqual({
      kind: "absent",
      vendor: "ashby",
      slug: "baseten",
      url: "https://jobs.ashbyhq.com/baseten",
    });
  });

  // Mutation this catches: parsing the URL loosely enough that a non-honest ATS
  // reaches the fetch. It would probe a board endpoint that does not exist for
  // that vendor, and every such row would come back "unreachable" — inert, but
  // one wasted request per role per pass.
  test("a link on a vendor with no honest board API is `notApplicable`, and fetches nothing", async () => {
    const fetchMock = stubBoard(ashbyBoard([]));

    const res = await verifyPostingLink(
      "https://acme.wd1.myworkdayjobs.com/en-US/careers/job/123",
      "GTM Engineer"
    );

    expect(res).toEqual({ kind: "notApplicable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a bare board page is `notApplicable` — no posting id to verify", async () => {
    const fetchMock = stubBoard(ashbyBoard([]));

    expect((await verifyPostingLink("https://jobs.ashbyhq.com/baseten", "GTM Engineer")).kind).toBe(
      "notApplicable"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Mutation this catches: dropping parseAshbyBoard's isListed filter, or
  // matching against hidden postings here. A posting hidden from the board is a
  // page a candidate cannot use, so relinking to it is worse than doing nothing.
  test("a hidden posting is not something to relink to", async () => {
    stubBoard(ashbyBoard([{ title: "GTM Engineer", jobUrl: LIVE, isListed: false }]));

    expect((await verifyPostingLink(STALE, "GTM Engineer")).kind).toBe("unclear");
  });

  // Mutation this catches: comparing host+path instead of posting identity —
  // the shape this file shipped with. Ashby hangs `/application` off a live
  // posting, so this stored link IS the board's posting and must be `listed`.
  // Under a path comparison it fell through to findPosting and RELINKED a
  // healthy row to itself; with two near-matching titles on the board it would
  // have reported a live role `ambiguous`, which the report offers a
  // "Move to Out" button for.
  test("an /application step on the correct posting is listed, not relinked", async () => {
    stubBoard(ashbyBoard([{ title: "GTM Engineer", jobUrl: LIVE }]));

    expect((await verifyPostingLink(`${LIVE}/application`, "GTM Engineer")).kind).toBe("listed");
  });

  test("a Lever /apply step on the correct posting is listed", async () => {
    const posting = "https://jobs.lever.co/atlan/8f0a-1";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => [{ text: "GTM Engineer", hostedUrl: posting }] }))
    );

    expect((await verifyPostingLink(`${posting}/apply`, "GTM Engineer")).kind).toBe("listed");
  });

  // Mutation this catches: requiring host equality. Greenhouse migrated hosts
  // and serves one req from boards., job-boards. and the .eu. variants of both,
  // so a stored link and the API's `absolute_url` routinely disagree on host
  // for the SAME posting. Under host equality every Greenhouse row in the table
  // is a relink candidate.
  test("a Greenhouse posting stored under the old host is listed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          jobs: [
            { title: "GTM Engineer", absolute_url: "https://job-boards.greenhouse.io/clay/jobs/4012" },
          ],
        }),
      }))
    );

    const res = await verifyPostingLink(
      "https://boards.greenhouse.io/clay/jobs/4012",
      "GTM Engineer"
    );

    expect(res.kind).toBe("listed");
  });

  // Mutation this catches: comparing slugs case-sensitively. The id must stay
  // case-sensitive (base62 on two vendors), but the slug names the BOARD, and a
  // stored link carrying a capitalized board token is the same board as the
  // API's lowercase one — the same false-relink class as the host mismatch
  // above, reached through the path instead of the host.
  test("a Greenhouse posting stored with a capitalized board token is listed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          jobs: [
            { title: "GTM Engineer", absolute_url: "https://job-boards.greenhouse.io/clay/jobs/4012" },
          ],
        }),
      }))
    );

    const res = await verifyPostingLink(
      "https://job-boards.greenhouse.io/Clay/jobs/4012",
      "GTM Engineer"
    );

    expect(res.kind).toBe("listed");
  });

  // Mutation this catches: dropping the empty-slug half of the identity
  // comparison. parseWorkableBoard falls back to `shortlink`, which names no
  // company, so a slug-equality requirement calls the stored posting missing.
  test("a Workable shortlink from the board matches the stored company URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          jobs: [{ title: "GTM Engineer", shortlink: "https://apply.workable.com/j/ABC123" }],
        }),
      }))
    );

    const res = await verifyPostingLink(
      "https://apply.workable.com/asseti/j/ABC123/",
      "GTM Engineer"
    );

    expect(res.kind).toBe("listed");
  });

  // Mutation this catches: treating a genuinely different id as the same
  // posting — e.g. comparing only vendor+slug. That would call every stale link
  // on a live board "listed" and the whole fix would do nothing.
  test("a different posting id on the same board is still not this posting", async () => {
    stubBoard(ashbyBoard([{ title: "GTM Engineer", jobUrl: LIVE }]));

    expect((await verifyPostingLink(STALE, "GTM Engineer")).kind).toBe("relink");
  });

  // Mutation this catches: caching the RESULT instead of the promise, or
  // keying the cache by URL rather than by board. Either lets N roles at one
  // company fire N concurrent identical requests — and a rate-limited board
  // answers `unreachable`, which is inert, so the whole check would go quiet.
  test("one board is fetched once per pass, however many roles ask", async () => {
    const fetchMock = stubBoard(ashbyBoard([{ title: "GTM Engineer", jobUrl: LIVE }]));
    const cache = newBoardCache();

    await Promise.all([
      verifyPostingLink(STALE, "GTM Engineer", cache),
      verifyPostingLink(LIVE, "GTM Engineer", cache),
      verifyPostingLink("https://jobs.ashbyhq.com/baseten/third-id", "GTM Engineer", cache),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a different board in the same pass is still its own fetch", async () => {
    const fetchMock = stubBoard(ashbyBoard([]));
    const cache = newBoardCache();

    await verifyPostingLink(STALE, "GTM Engineer", cache);
    await verifyPostingLink("https://jobs.ashbyhq.com/other/an-id", "GTM Engineer", cache);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("a Workable shortlink is not a board to look anything up on", async () => {
    const fetchMock = stubBoard(ashbyBoard([]));

    const res = await verifyPostingLink("https://apply.workable.com/j/ABC123", "GTM Engineer");

    expect(res).toEqual({ kind: "notApplicable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
