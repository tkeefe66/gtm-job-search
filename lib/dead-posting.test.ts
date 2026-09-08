import { describe, expect, test } from "vitest";

import { deadPostingMarker } from "./dead-posting";

// Aggregators serve SOFT 404s: HTTP 200 with a page that says the job is gone.
// checkJobUrl only closes on a definitive 404/410, so these rows sat as New
// indefinitely — a real one on 2026-09-07 was a BuiltIn page reading "Sorry,
// this job was removed at 04:07 a.m. (UTC) on Thursday, Jan 08, 2026" while
// answering 200.
describe("a page that says the posting is gone", () => {
  test("BuiltIn's own wording, as served", () => {
    const html = `<div class="alert">Sorry, this job was removed at 04:07 a.m. (UTC) on Thursday, Jan 08, 2026</div>`;

    expect(deadPostingMarker(html)).toBe("this job was removed");
  });

  test("the common variants are caught", () => {
    for (const phrase of [
      "This job is no longer available",
      "no longer accepting applications",
      "This position has been filled",
      "this posting has expired",
    ]) {
      expect(deadPostingMarker(`<p>${phrase}</p>`)).not.toBeNull();
    }
  });

  test("matching ignores case and collapsed markup whitespace", () => {
    expect(deadPostingMarker("<p>THIS   JOB\n  WAS  REMOVED</p>")).toBe("this job was removed");
  });

  // The precision half. Closing a role is reversible but visible, and these
  // pages are FULL of unrelated copy — related-jobs rails, cookie banners,
  // employer marketing. A phrase has to be about THIS posting.
  test("a live posting is not closed by nearby words", () => {
    for (const html of [
      "<p>Apply now. This job is remote.</p>",
      "<p>Removed from your saved jobs</p>",
      "<p>We filled 30 positions last year</p>",
      "<p>Your session has expired, please sign in</p>",
      "<p>Jobs are no longer posted to this legacy board — see our careers page</p>",
    ]) {
      expect(deadPostingMarker(html)).toBeNull();
    }
  });

  test("an empty or absent page says nothing either way", () => {
    expect(deadPostingMarker("")).toBeNull();
  });
});
