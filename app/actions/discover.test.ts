import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callWithWebSearchDetailed: vi.fn(),
  requireActor: vi.fn(),
  resolveTenantId: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock("@/lib/model-call", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/model-call")>();
  return {
    ...actual,
    callWithWebSearchDetailed: mocks.callWithWebSearchDetailed,
  };
});

vi.mock("@/lib/require-actor", () => ({
  requireActor: mocks.requireActor,
}));

vi.mock("@/lib/tenant", () => ({
  resolveTenantId: mocks.resolveTenantId,
}));

vi.mock("@/lib/metered", () => ({
  withBudget: vi.fn(async ({ fn }: { fn: () => Promise<unknown> }) => ({
    result: await fn(),
  })),
}));

vi.mock("@/lib/search-criteria", () => ({
  dateContextLine: vi.fn(() => "Today's date is September 9, 2026."),
  loadCriteriaAndScoringInputs: vi.fn(async () => ({
    criteria: { locationRule: "Remote" },
    profile: {
      hiringSignal: {
        name: "funding rounds",
        hasRecency: true,
        qualifier: "Series B and above",
        exclusions: "seed rounds",
        sources: ["TechCrunch"],
        extraFields: [],
      },
    },
  })),
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    forTenant: vi.fn(() => ({
      from: vi.fn(() => ({ upsert: mocks.upsert })),
    })),
  },
}));

import { discoverStartups } from "./discover";

beforeEach(() => {
  mocks.callWithWebSearchDetailed.mockReset();
  mocks.requireActor.mockReset();
  mocks.resolveTenantId.mockReset();
  mocks.upsert.mockReset();

  mocks.requireActor.mockResolvedValue({ isAdmin: true });
  mocks.resolveTenantId.mockResolvedValue("tenant-1");
  mocks.upsert.mockResolvedValue({ error: null });
});

describe("discoverStartups search limits", () => {
  test("allows a complete 20-company response without allowing an unbounded search fan-out", async () => {
    // Mutation: restore the smaller output budget. The shared facade's
    // default search ceiling is separately asserted in model-call.test.ts.
    mocks.callWithWebSearchDetailed.mockResolvedValue({
      text: "[]",
      stopReason: "end_turn",
    });

    await discoverStartups(undefined, "7d");

    expect(mocks.callWithWebSearchDetailed).toHaveBeenCalledWith(
      expect.objectContaining({ maxTokens: 16000 })
    );
  });

  test("returns a useful message when Anthropic still truncates the response", async () => {
    // Mutation this catches: letting the JSON SyntaxError escape from the
    // incomplete array, which exposes parser internals in the Discover banner.
    mocks.callWithWebSearchDetailed.mockResolvedValue({
      text: '[{"company":"Acme"}',
      stopReason: "max_tokens",
    });

    const result = await discoverStartups(undefined, "7d");

    expect(result.error).toBe(
      "The search produced too much data to finish. Please retry."
    );
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});
