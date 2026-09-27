import { expect, test, vi } from "vitest";
vi.mock("./supabase", () => ({ rawQuery: vi.fn() }));
import { COMPANY_SEARCH_LIMIT, paidSearchDecision, modelBackoff } from "./crawl-policy";

// Mutation: inherited By Role's 50-search default or allowed automatic search without opt-in.
test("company checks require explicit paid-search permission and cap five", () => {
  expect(COMPANY_SEARCH_LIMIT).toBe(5);
  for (const trigger of ["automatic", "check"] as const) {
    expect(paidSearchDecision({ trigger, allowPaidSearch: false, modelRetryAfter: null }).allowed).toBe(false);
  }
  expect(paidSearchDecision({ trigger: "deep", allowPaidSearch: false, modelRetryAfter: "2099-01-01" }).allowed).toBe(true);
});

// Mutation: count a budget skip as model failure or reset failure evidence on a free unchanged check.
test("backoff starts at two model failures and preserves non-model outcomes", () => {
  const now = new Date("2026-09-27T12:00:00Z");
  const first = modelBackoff(0, null, "failure", now);
  expect(first).toEqual({ failures: 1, retryAfter: null });
  const second = modelBackoff(1, null, "failure", now);
  expect(second).toEqual({ failures: 2, retryAfter: "2026-10-04T12:00:00.000Z" });
  expect(modelBackoff(2, second.retryAfter, "none", now)).toEqual(second);
  expect(modelBackoff(2, second.retryAfter, "failure", now).retryAfter).toBe("2026-10-11T12:00:00.000Z");
  expect(modelBackoff(3, null, "failure", now).retryAfter).toBe("2026-10-27T12:00:00.000Z");
  expect(modelBackoff(9, second.retryAfter, "success", now)).toEqual({ failures: 0, retryAfter: null });
});
