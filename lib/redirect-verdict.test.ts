import { describe, expect, test } from "vitest";

import { redirectVerdict } from "./redirect-verdict";

// A posting whose req is closed is often not 404'd. It is REDIRECTED to the
// careers listing it came from, and the listing answers 200 — so every
// status-code check in this codebase called the link live.
//
// Measured on 2026-09-07 against the real row that prompted this:
//   dead  samsara.com/company/careers/roles/7974118 -> /company/careers/roles
//   live  samsara.com/company/careers/roles/8024328 -> no redirect
//   dead  job-boards.greenhouse.io/samsara/jobs/8052310 -> samsara.com/company/careers/roles
// The third is why this is not "did we land on an ancestor of where we asked":
// the landing page is on a different HOST than the link, and an ancestor test
// cannot see it.
describe("a redirect that landed on a listing", () => {
  test("the employer's own site drops the posting id", () => {
    expect(
      redirectVerdict(
        "https://www.samsara.com/company/careers/roles/7974118",
        "https://www.samsara.com/company/careers/roles"
      )
    ).toBe("landed-on-listing");
  });

  test("a cross-host hop off the ATS is caught too", () => {
    expect(
      redirectVerdict(
        "https://job-boards.greenhouse.io/samsara/jobs/8052310",
        "https://www.samsara.com/company/careers/roles"
      )
    ).toBe("landed-on-listing");
  });

  test("a board root reached from its own posting", () => {
    expect(
      redirectVerdict(
        "https://boards.greenhouse.io/acme/jobs/4512339",
        "https://boards.greenhouse.io/acme"
      )
    ).toBe("landed-on-listing");
  });

  test("a slug id, not just a numeric one", () => {
    expect(
      redirectVerdict(
        "https://jobs.lever.co/acme/8f2c1a44-3b7e-4d21-9c05-2ab7de991f60",
        "https://jobs.lever.co/acme"
      )
    ).toBe("landed-on-listing");
  });
});

// The precision half, and the reason this returns three values rather than a
// boolean. Closing a role here also stamps never_live at ingest, which HIDES
// the row — so every ordinary redirect a healthy link goes through has to come
// back "same".
describe("a redirect that changed nothing about the posting", () => {
  test("scheme, host and trailing-slash normalisation", () => {
    for (const [from, to] of [
      ["http://www.samsara.com/company/careers/roles/7974118", "https://www.samsara.com/company/careers/roles/7974118"],
      ["https://samsara.com/company/careers/roles/7974118", "https://www.samsara.com/company/careers/roles/7974118"],
      ["https://www.samsara.com/company/careers/roles/7974118", "https://www.samsara.com/company/careers/roles/7974118/"],
      ["https://boards.greenhouse.io/acme/jobs/4512339?gh_src=abc", "https://boards.greenhouse.io/acme/jobs/4512339"],
    ]) {
      expect(redirectVerdict(from, to)).toBe("same");
    }
  });

  test("a locale prefix or a slug appended to the id", () => {
    expect(
      redirectVerdict(
        "https://acme.com/careers/4512339",
        "https://acme.com/en-us/careers/4512339-staff-engineer"
      )
    ).toBe("same");
  });

  test("no redirect at all", () => {
    const url = "https://www.samsara.com/company/careers/roles/8024328";
    expect(redirectVerdict(url, url)).toBe("same");
  });
});

// The third value. The posting id changed AND the landing page still names a
// posting — a genuine move, or a stranger's req. Evidence of neither life nor
// death, so it must not be folded into either of the other two.
describe("a redirect that landed on a different posting", () => {
  test("a new id is a move, not a closure", () => {
    expect(
      redirectVerdict(
        "https://boards.greenhouse.io/acme/jobs/4512339",
        "https://boards.greenhouse.io/acme/jobs/9987001"
      )
    ).toBe("moved");
  });
});

// Inputs that carry no identifier to reason about. A link that never named a
// posting cannot be judged closed by this rule, however it redirects.
describe("a link with no posting identifier", () => {
  test("a bare careers page is never landed-on-listing", () => {
    expect(
      redirectVerdict("https://www.samsara.com/company/careers", "https://www.samsara.com/company/careers/roles")
    ).toBe("same");
  });

  test("unparseable input is inert", () => {
    expect(redirectVerdict("not a url", "https://acme.com/careers")).toBe("same");
    expect(redirectVerdict("https://acme.com/jobs/4512339", "not a url")).toBe("same");
  });
});
