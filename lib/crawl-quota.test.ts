import { describe, expect, test } from "vitest";
import { crawlQuotaVerdict } from "./crawl-quota";

describe("crawlQuotaVerdict", () => {
  test("allows tracking below the quota", () => {
    expect(crawlQuotaVerdict({ tracked: 3, quota: 10, isAdmin: false }).allow).toBe(true);
  });

  test("refuses AT the quota, not one past it", () => {
    // `tracked` is the count BEFORE adding, so being at the quota means the next
    // one would exceed it. Off by one here silently grants everyone quota+1.
    expect(crawlQuotaVerdict({ tracked: 10, quota: 10, isAdmin: false }).allow).toBe(false);
    expect(crawlQuotaVerdict({ tracked: 9, quota: 10, isAdmin: false }).allow).toBe(true);
  });

  test("the refusal explains the shared-capacity reason, not just the number", () => {
    const v = crawlQuotaVerdict({ tracked: 10, quota: 10, isAdmin: false });
    expect(v.reason).toContain("10");
    expect(v.reason).toContain("Untrack");
    expect(v.reason).toContain("shared");
  });

  test("the admin is exempt from the count", () => {
    expect(crawlQuotaVerdict({ tracked: 500, quota: 10, isAdmin: true }).allow).toBe(true);
  });

  test("a quota of zero refuses everyone who is not admin", () => {
    expect(crawlQuotaVerdict({ tracked: 0, quota: 0, isAdmin: false }).allow).toBe(false);
  });
});
