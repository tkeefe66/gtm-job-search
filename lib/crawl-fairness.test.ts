import { describe, expect, test } from "vitest";
import { splitCrawlBatch } from "./crawl-fairness";

const total = (s: { limit: number }[]) => s.reduce((n, x) => n + x.limit, 0);

describe("splitCrawlBatch", () => {
  test("one tenant takes the whole budget", () => {
    expect(splitCrawlBatch(["a"], 3)).toEqual([{ tenantId: "a", limit: 3 }]);
  });

  test("never allocates more than the budget", () => {
    for (const n of [1, 2, 3, 7]) {
      for (const limit of [0, 1, 3, 10]) {
        const ids = Array.from({ length: n }, (_, i) => `t${i}`);
        expect(total(splitCrawlBatch(ids, limit))).toBe(Math.max(0, limit));
      }
    }
  });

  // The failure this exists to prevent: with 3 slots and 5 tenants, a plain
  // slice would crawl tenants 1-3 every night and never touch 4 or 5 — and
  // nothing would report it. Their watchlists would just look like companies
  // that are never hiring.
  test("rotation eventually reaches every tenant", () => {
    const ids = ["a", "b", "c", "d", "e"];
    const seen = new Set<string>();
    for (let day = 0; day < ids.length; day++) {
      for (const s of splitCrawlBatch(ids, 3, day)) seen.add(s.tenantId);
    }
    expect(seen.size).toBe(ids.length);
  });

  test("more tenants than slots still crawls somebody", () => {
    const slices = splitCrawlBatch(["a", "b", "c", "d", "e"], 3);
    expect(slices.length).toBe(3);
    expect(total(slices)).toBe(3);
  });

  test("a tenant with no slot is omitted, not given zero", () => {
    for (const s of splitCrawlBatch(["a", "b", "c", "d"], 2)) {
      expect(s.limit).toBeGreaterThan(0);
    }
  });

  test("no tenants, or no budget, allocates nothing", () => {
    expect(splitCrawlBatch([], 3)).toEqual([]);
    expect(splitCrawlBatch(["a"], 0)).toEqual([]);
  });

  test("a negative or huge rotation still lands in range", () => {
    expect(() => splitCrawlBatch(["a", "b"], 2, -7)).not.toThrow();
    expect(total(splitCrawlBatch(["a", "b"], 2, -7))).toBe(2);
    expect(total(splitCrawlBatch(["a", "b"], 2, 10_000))).toBe(2);
  });
});
