import { describe, expect, test } from "vitest";
import { pickNextTenant, type TenantCandidate } from "./crawl-next";

const cand = (over: Partial<TenantCandidate> & { tenantId: string }): TenantCandidate => ({
  company: "Acme",
  crawlsToday: 0,
  lastCheckedAt: "2026-08-01T00:00:00.000Z",
  ...over,
});

describe("pickNextTenant", () => {
  test("nobody has work, so nothing is picked", () => {
    expect(pickNextTenant([])).toBeNull();
  });

  test("a tenant with no due company is not picked, however overdue it looks", () => {
    expect(pickNextTenant([cand({ tenantId: "a", company: null })])).toBeNull();
  });

  test("the only tenant with work is picked", () => {
    const picked = pickNextTenant([
      cand({ tenantId: "a", company: null }),
      cand({ tenantId: "b", company: "Beta" }),
    ]);
    expect(picked?.tenantId).toBe("b");
  });

  // THE FAIRNESS RULE. This is what replaces splitCrawlBatch's rotation: the
  // tenant who has had the least so far goes next. Without it, selecting purely
  // by most-overdue lets one tenant with a large watchlist take every slot
  // forever, because their oldest row is always older than everybody else's.
  test("the tenant with fewest crawls today wins, even against an older company", () => {
    const picked = pickNextTenant([
      cand({ tenantId: "busy", crawlsToday: 5, lastCheckedAt: "2020-01-01T00:00:00.000Z" }),
      cand({ tenantId: "quiet", crawlsToday: 0, lastCheckedAt: "2026-08-10T00:00:00.000Z" }),
    ]);
    expect(picked?.tenantId).toBe("quiet");
  });

  test("tied on crawls today, the most overdue company wins", () => {
    const picked = pickNextTenant([
      cand({ tenantId: "newer", crawlsToday: 2, lastCheckedAt: "2026-08-10T00:00:00.000Z" }),
      cand({ tenantId: "older", crawlsToday: 2, lastCheckedAt: "2026-01-01T00:00:00.000Z" }),
    ]);
    expect(picked?.tenantId).toBe("older");
  });

  test("a company never checked outranks any company that has been", () => {
    const picked = pickNextTenant([
      cand({ tenantId: "checked", lastCheckedAt: "1999-01-01T00:00:00.000Z" }),
      cand({ tenantId: "never", lastCheckedAt: null }),
    ]);
    expect(picked?.tenantId).toBe("never");
  });

  // Determinism matters more than which one wins: the loop calls this once per
  // crawl, and a tie broken at random would make a stuck tenant's behaviour
  // impossible to reproduce from the logs.
  test("a total tie is broken by tenant id, so the choice is reproducible", () => {
    const input = [cand({ tenantId: "b" }), cand({ tenantId: "a" })];
    expect(pickNextTenant(input)?.tenantId).toBe("a");
    expect(pickNextTenant([...input].reverse())?.tenantId).toBe("a");
  });

  test("picking does not reorder the caller's array", () => {
    const input = [cand({ tenantId: "b" }), cand({ tenantId: "a" })];
    pickNextTenant(input);
    expect(input.map((c) => c.tenantId)).toEqual(["b", "a"]);
  });
});
