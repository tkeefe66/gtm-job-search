import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The pricing gate on a stored model.
 *
 * `components/ApiKeyPanel.tsx` ships a FREE-TEXT model field, and the meter is
 * the owner's only runaway protection. A model the provider cannot price is
 * metered at the default model's rate: for a 5x model that records a fifth of
 * real spend, lets both ceilings pass ~5x the intended dollars, and renders the
 * per-run estimate on /settings wrong by the same factor. So it must not be
 * storable at all.
 *
 * The edges are mocked and the decision is kept — the same harness note as
 * app/actions/parse-role.test.ts. `requireActor` is mocked here because this
 * suite is about the gate; that the guard EXISTS on every action is asserted
 * separately in app/actions/auth-required.test.ts.
 */
vi.mock("@/lib/require-actor", () => ({
  requireActor: async () => ({
    userId: "test-user",
    tenantId: "test-user",
    email: "test@example.com",
    isAdmin: false,
  }),
}));
vi.mock("@/lib/tenant", () => ({ resolveTenantId: async () => "test-user" }));

const rawQuery = vi.fn();
vi.mock("@/lib/supabase", () => ({ rawQuery: (...a: unknown[]) => rawQuery(...a) }));

const sealKey = vi.fn((_key: string, _aad: unknown) => ({
    keyId: "k", aadVersion: 2, ciphertext: "c", nonce: "n", authTag: "t",
  }));
vi.mock("@/lib/secret-box", () => ({
  seal: (...args: unknown[]) => sealKey(args[0] as string, args[1]),
  lastFour: (k: string) => k.slice(-4),
}));

const validateKey = vi.fn();
vi.mock("@/lib/providers/registry", () => ({
  providerFor: (id: string) => {
    const models: Record<string, string> = { anthropic: "claude-sonnet-4-6", openai: "gpt-4.1", google: "gemini-2.5-flash" };
    if (!models[id]) throw new Error("unsupported");
    return { id, defaultModel: models[id], pricedModels: [models[id]], validateKey };
  },
}));

import { saveApiKey } from "./api-key";

beforeEach(() => {
  vi.clearAllMocks();
  validateKey.mockResolvedValue({ ok: true });
  // Every query succeeds and nothing is rate-limited, so the only thing that
  // can refuse a save in these tests is the gate under test.
  rawQuery.mockResolvedValue({ data: [], error: null });
});

describe("a model the provider cannot price is not storable", () => {
  test("an unpriced model is refused, naming the closed set it must come from", async () => {
    const res = await saveApiKey("sk-ant-plausible", { model: "claude-opus-4-1" });

    expect(res.error).toBeTruthy();
    expect(res.error).toContain("claude-sonnet-4-6");
    // Refused before the network and before anything is written: the gate is
    // free, and a rejected save must leave no row behind.
    expect(validateKey).not.toHaveBeenCalled();
    expect(rawQuery.mock.calls.some((c) => String(c[0]).includes("insert into"))).toBe(false);
  });

  test("a priced model is accepted and stored", async () => {
    const res = await saveApiKey("sk-ant-plausible", { model: "claude-sonnet-4-6" });

    expect(res.error).toBeUndefined();
    expect(validateKey).toHaveBeenCalledWith("sk-ant-plausible", "claude-sonnet-4-6");
    expect(rawQuery.mock.calls.some((c) => String(c[0]).includes("insert into"))).toBe(true);
  });

  test("an omitted model resolves to the provider's default, which is priced", async () => {
    const res = await saveApiKey("sk-ant-plausible");

    expect(res.error).toBeUndefined();
    expect(validateKey).toHaveBeenCalledWith("sk-ant-plausible", "claude-sonnet-4-6");
  });
});


describe("selected API provider", () => {
  // Mutation: persist or seal every key as Anthropic regardless of selection.
  test.each([["openai", "gpt-4.1"], ["google", "gemini-2.5-flash"]])("keeps %s routing bound to the saved key", async (provider, model) => {
    expect(await saveApiKey("test-provider-key", { provider })).toEqual({});
    expect(validateKey).toHaveBeenCalledWith("test-provider-key", model);
    const insert = rawQuery.mock.calls.find(c => String(c[0]).includes("insert into"));
    expect(insert?.[1][7]).toBe(provider);
    expect(sealKey).toHaveBeenCalledWith("test-provider-key", { tenantId: "test-user", provider, model: null });
  });
  // Mutation: route unknown provider names to the default vendor.
  test("rejects unknown providers without transmitting the key", async () => {
    expect((await saveApiKey("secret-key", { provider: "unknown" })).error).toMatch(/supported provider/);
    expect(validateKey).not.toHaveBeenCalled();
    expect(sealKey).not.toHaveBeenCalled();
  });
  // Mutation: allow a model belonging to another vendor.
  test("rejects a model from another provider before validation", async () => {
    expect((await saveApiKey("secret-key", { provider: "google", model: "gpt-4.1" })).error).toBeDefined();
    expect(validateKey).not.toHaveBeenCalled();
  });
  // Mutation: return the provider SDK exception (which may contain a key).
  test("does not expose a failed verification request", async () => {
    validateKey.mockRejectedValue(new Error("https://example.invalid/?key=secret-key"));
    const result = await saveApiKey("secret-key", { provider: "openai" });
    expect(result.error).toMatch(/try again/i);
    expect(result.error).not.toContain("secret-key");
  });
});
