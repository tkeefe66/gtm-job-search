import { afterEach, describe, expect, test, vi } from "vitest";

import { checkJobUrl } from "./verify-url";

/**
 * Stubs fetch as a redirect-follower: whatever URL is asked for, the response
 * reports `landing` as the URL it ended up at, which is what the platform's
 * `redirect: "follow"` does.
 */
function landingOn(landing: string, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ status, url: landing }) as unknown as Response)
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const POSTING = "https://www.samsara.com/company/careers/roles/7974118";
const LISTING = "https://www.samsara.com/company/careers/roles";

describe("a 200 that was reached by redirect", () => {
  // The row that prompted this. Every status-code check called it live while
  // the posting had been gone for days.
  test("landing on the careers listing is dead", async () => {
    landingOn(LISTING);

    expect(await checkJobUrl(POSTING)).toBe("dead");
  });

  test("landing on the posting itself is live", async () => {
    landingOn(POSTING);

    expect(await checkJobUrl(POSTING)).toBe("live");
  });

  // A moved posting is evidence of neither life nor death, and closing here
  // would also stamp never_live at ingest and hide the row.
  test("landing on a different posting is live", async () => {
    landingOn("https://boards.greenhouse.io/acme/jobs/9987001");

    expect(await checkJobUrl("https://boards.greenhouse.io/acme/jobs/4512339")).toBe("live");
  });

  // The redirect rule reads a 200. It must not promote an ambiguous status.
  test("a blocked request stays unknown however it redirected", async () => {
    landingOn(LISTING, 403);

    expect(await checkJobUrl(POSTING)).toBe("unknown");
  });
});
