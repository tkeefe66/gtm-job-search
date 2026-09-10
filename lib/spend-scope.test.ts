import { beforeEach, expect, test, vi } from "vitest";
const completeCall = vi.fn();
const searchCall = vi.fn();
vi.mock("@/lib/providers/registry", () => ({ providerFor: () => ({
  id: "anthropic", searchCapEnforcement: "in-request",
  costCents: (usage: { searches: number; inputTokens: number }) => usage.searches + usage.inputTokens,
  complete: (...a: unknown[]) => completeCall(...a),
  searchAndComplete: (...a: unknown[]) => searchCall(...a),
}) }));
import { complete, callWithWebSearch } from "./model-call";
import { runWithBilling, type BillingScope } from "./billing-context";
const opts = { system: "test", prompt: "test" };
const scope = (): BillingScope => ({
  provider: "anthropic", model: "test", apiKey: "test", maxSearches: 10,
  availableCents: 10, limitMessage: "Spending limit reached. Raise it in Settings.",
  inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, searches: 0,
});
beforeEach(() => {
  vi.clearAllMocks();
  const response = { text: "ok", stopReason: "end_turn", usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 0, searches: 0 } };
  completeCall.mockResolvedValue(response);
  searchCall.mockResolvedValue(response);
});

// Mutation: check caps only at the outer action, allowing a loop of inner model calls.
test("after one response reaches the cap, another model request cannot start", async () => {
  await runWithBilling(scope(), async () => {
    await expect(complete(opts)).resolves.toBe("ok");
    await expect(complete(opts)).rejects.toThrow("Spending limit reached");
  });
  expect(completeCall).toHaveBeenCalledTimes(1);
});

// Mutation: reuse the initial search allowance after tokens have consumed part of it.
test("later search requests use only the remaining allowance", async () => {
  const current = scope();
  current.inputTokens = 4;
  await runWithBilling(current, async () => callWithWebSearch(opts));
  expect(searchCall).toHaveBeenCalledWith(expect.objectContaining({ maxSearches: 6 }));
});

// Mutation: fail to check zero before starting a provider request.
test("a consumed scope refuses searches too", async () => {
  const current = scope();
  current.inputTokens = 10;
  await expect(runWithBilling(current, async () => callWithWebSearch(opts))).rejects.toThrow("Settings");
  expect(searchCall).not.toHaveBeenCalled();
});
