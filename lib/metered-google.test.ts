import { expect, test, vi } from "vitest";

const reconcileSpend = vi.fn(async () => ({}));
vi.mock("@/lib/usage-store", () => ({ reconcileSpend: (...args: unknown[]) => reconcileSpend(...args), reserveSpend: vi.fn() }));
vi.mock("@/lib/tenant", () => ({ resolveTenantId: async () => "tenant-test" }));
vi.mock("@/lib/secret-box", () => ({ open: () => "test-key" }));
vi.mock("@/lib/supabase", () => ({ rawQuery: async (sql: string) => ({ data: sql.includes("from tenant_api_keys") ? [{ provider: "google", model: "gemini-2.5-flash" }] : [], error: null }) }));

import { withBudget } from "./metered";
import { recordUsage } from "./billing-context";

test("reconciliation prices grounded prompts, not each query within them", async () => {
  const result = await withBudget({ action: "test", estimateCents: 10, isAdmin: false, fn: async () => {
    recordUsage({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, searches: 3, groundedRequests: 1 });
    recordUsage({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, searches: 2, groundedRequests: 1 });
    return "ok";
  } });
  expect(result).toEqual({ result: "ok" });
  expect(reconcileSpend).toHaveBeenCalledWith(expect.objectContaining({ actualCents: 7, searches: 5, billedTo: "tenant" }));
});
