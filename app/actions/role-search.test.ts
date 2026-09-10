import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callWithWebSearchDetailed: vi.fn(),
  requireActor: vi.fn(),
  resolveTenantId: vi.fn(),
  upsert: vi.fn(),
  getWatchedCompanyKeys: vi.fn(),
}));

vi.mock("@/lib/model-call", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/model-call")>();
  return { ...actual, callWithWebSearchDetailed: mocks.callWithWebSearchDetailed };
});

vi.mock("@/lib/require-actor", () => ({ requireActor: mocks.requireActor }));
vi.mock("@/lib/tenant", () => ({ resolveTenantId: mocks.resolveTenantId }));

vi.mock("@/lib/metered", () => ({
  withBudget: vi.fn(async ({ fn }: { fn: () => Promise<unknown> }) => ({
    result: await fn(),
  })),
}));

vi.mock("@/lib/search-criteria", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/search-criteria")>();
  return {
    ...actual,
    loadSearchInputs: vi.fn(async () => ({
      criteria: {
        titles: ["Director of Operations"],
        locations: ["Remote"],
        stackTerms: Array.from({ length: 60 }, (_, i) => `Tool ${i + 1}`),
        locationRule: "Remote roles only.",
        fitBrain: "An operations leader.",
      },
      ceiling: null,
      fitInputs: {},
      profile: {
        querySubject: "operations leadership",
        searchSubject: "operations leadership roles",
        stackFamilyIntro: "Search for operations roles using these tools",
        candidatePersona: "an operations leader",
        buildingConcept: "systems",
        buildingUpside: "automation",
      },
    })),
  };
});

vi.mock("@/lib/supabase", () => ({
  supabase: {
    forTenant: vi.fn(() => ({
      from: vi.fn(() => ({ upsert: mocks.upsert })),
    })),
  },
}));

vi.mock("@/app/actions/watchlist", () => ({
  getWatchedCompanyKeys: mocks.getWatchedCompanyKeys,
}));

vi.mock("@/lib/ingest-roles", () => ({
  MAX_SEARCH_READS: 20,
  ingestRoles: vi.fn(),
}));

import { findRolesByCriteria } from "./role-search";

beforeEach(() => {
  mocks.callWithWebSearchDetailed.mockReset();
  mocks.requireActor.mockReset();
  mocks.resolveTenantId.mockReset();
  mocks.upsert.mockReset();
  mocks.getWatchedCompanyKeys.mockReset();

  mocks.requireActor.mockResolvedValue({ isAdmin: true });
  mocks.resolveTenantId.mockResolvedValue("tenant-1");
  mocks.upsert.mockResolvedValue({ error: null });
  mocks.getWatchedCompanyKeys.mockResolvedValue({ keys: new Set<string>() });
});

describe("findRolesByCriteria search boundaries", () => {
  test("partial batches reach the user without replacing the complete cache", async () => {
    // Mutation: cache a partial run as complete, or discard its successful first batch.
    mocks.callWithWebSearchDetailed
      .mockResolvedValueOnce({ text: '[{"company":"Acme","role_title":"Director"}]', stopReason: "end_turn" })
      .mockResolvedValueOnce({ text: "[]", stopReason: "max_tokens" });
    const result = await findRolesByCriteria("stack", true);
    expect(result.matches).toEqual([{ company: "Acme", role_title: "Director" }]);
    expect(result.error).toContain("Partial results");
    expect(result.fetchedAt).not.toBeNull();
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.callWithWebSearchDetailed).toHaveBeenCalledTimes(2);
  });
  test("uses the larger output allowance and default search ceiling", async () => {
    // Mutation this catches: restoring 8,000 output tokens or allowing an
    // unset setting to fan out beyond the new 32-search default.
    mocks.callWithWebSearchDetailed.mockResolvedValue({
      text: "[]",
      stopReason: "end_turn",
    });

    await findRolesByCriteria("stack", true);

    expect(mocks.callWithWebSearchDetailed).toHaveBeenCalledTimes(5);
    expect(mocks.callWithWebSearchDetailed).toHaveBeenCalledWith(
      expect.objectContaining({ maxTokens: 16000, maxSearches: 10 })
    );
  });

  test("returns a useful message when the larger response still truncates", async () => {
    // Mutation this catches: rethrowing the original JSON SyntaxError from a
    // response that Anthropic explicitly marked as max_tokens.
    mocks.callWithWebSearchDetailed.mockResolvedValue({
      text: '[{"company":"Acme"}',
      stopReason: "max_tokens",
    });

    const result = await findRolesByCriteria("stack", true);

    expect(result.error).toBe(
      "The search produced too much data to finish. Please retry."
    );
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});
