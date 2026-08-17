import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * "Could not ask" is not "no key stored".
 *
 * `loadTenantKey` used to destructure `{ data }` alone. An unreachable database
 * returns `data: []` with an error whose message is the EMPTY STRING (pg's
 * AggregateError — lib/write-failure.ts), so a dead database was
 * indistinguishable from a tenant who never stored a key: the tenant resolved
 * to tier "none" and read "add your API key" while Postgres was down.
 *
 * The database is the only thing mocked here. Everything the assertion turns on
 * — the presence check, the tier, the sentence — is the real code.
 */
const rawQuery = vi.fn();
vi.mock("@/lib/supabase", () => ({ rawQuery: (...a: unknown[]) => rawQuery(...a) }));
vi.mock("@/lib/tenant", () => ({ resolveTenantId: async () => "tenant-a" }));

// No ambient scope, so withBudget takes the full path rather than the nested
// short-circuit; runWithBilling just runs the block.
vi.mock("@/lib/billing-context", () => ({
  billingScope: () => null,
  runWithBilling: async (_scope: unknown, fn: () => Promise<unknown>) => fn(),
}));

import { withBudget } from "./metered";
import { needsKeyMessage } from "./budget";

const fn = vi.fn(async () => "ran");

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("a key lookup that FAILED is not a tenant without a key", () => {
  test("an unreachable database is reported as an error, not as 'add your API key'", async () => {
    // The empty message is the whole point: `if (error)` reads it as success.
    rawQuery.mockResolvedValue({ data: [], error: { message: "" } });

    const res = await withBudget({ action: "t", estimateCents: 1, isAdmin: false, fn });

    expect(res.error).toBeDefined();
    expect(res.error).not.toBe("");
    expect(res.capped).toBeUndefined();
    expect(res.error).not.toBe(needsKeyMessage());
    // Nothing may run against a key that could not be read.
    expect(fn).not.toHaveBeenCalled();
  });

  test("a clean read with no rows still means 'add your API key'", async () => {
    rawQuery.mockResolvedValue({ data: [], error: null });

    const res = await withBudget({ action: "t", estimateCents: 1, isAdmin: false, fn });

    expect(res.capped).toBe(needsKeyMessage());
    expect(res.error).toBeUndefined();
    expect(fn).not.toHaveBeenCalled();
  });
});
