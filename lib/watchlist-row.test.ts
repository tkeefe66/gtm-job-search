import { describe, expect, it } from "vitest";
import { needsYou, rowStateFor, type RowStateInput } from "./watchlist-row";

const base: RowStateInput = {
  trackingEnabled: true,
  lastCrawlStatus: "ok",
  consecutiveFailures: 0,
  isDue: false,
};

describe("rowStateFor", () => {
  it("reports a healthy tracked row as ok", () => {
    expect(rowStateFor(base)).toBe("ok");
  });

  it("reports an untracked row as ok whatever its history", () => {
    // The reason it stopped is rendered as prose; a state badge would compete
    // with it and say less.
    expect(
      rowStateFor({
        trackingEnabled: false,
        lastCrawlStatus: "needs_url",
        consecutiveFailures: 9,
        isDue: true,
      })
    ).toBe("ok");
  });

  // The four tests below are the reason this function exists: every input has
  // MORE THAN ONE true clause, so each one fails if the checks are reordered.

  it("prefers needs_url over failing — the missing URL is the actionable half", () => {
    expect(
      rowStateFor({ ...base, lastCrawlStatus: "needs_url", consecutiveFailures: 5 })
    ).toBe("needs_url");
  });

  it("prefers needs_url over due", () => {
    expect(
      rowStateFor({ ...base, lastCrawlStatus: "needs_url", isDue: true })
    ).toBe("needs_url");
  });

  it("prefers failing over due", () => {
    expect(rowStateFor({ ...base, consecutiveFailures: 3, isDue: true })).toBe(
      "failing"
    );
  });

  it("prefers due over empty — due says what happens next", () => {
    expect(rowStateFor({ ...base, lastCrawlStatus: "empty", isDue: true })).toBe(
      "due"
    );
  });

  it("reports empty only when nothing else applies", () => {
    expect(rowStateFor({ ...base, lastCrawlStatus: "empty" })).toBe("empty");
  });

  it("calls three consecutive failures failing, and two not", () => {
    // The boundary the row copy has always claimed. `> 3` would make a
    // three-failure row read healthy while the prose below it says otherwise.
    expect(rowStateFor({ ...base, consecutiveFailures: 3 })).toBe("failing");
    expect(rowStateFor({ ...base, consecutiveFailures: 2 })).toBe("ok");
  });
});

describe("needsYou", () => {
  it("covers exactly the states the crawler cannot resolve on its own", () => {
    expect(needsYou("needs_url")).toBe(true);
    expect(needsYou("failing")).toBe(true);
    // Due and empty resolve themselves: the crawler reaches a due row, and an
    // empty one is a working page with nothing to say.
    expect(needsYou("due")).toBe(false);
    expect(needsYou("empty")).toBe(false);
    expect(needsYou("ok")).toBe(false);
  });
});
