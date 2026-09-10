import { beforeEach, expect, test, vi } from "vitest";

const rawQuery = vi.fn();
const reserveSpend = vi.fn();
const reconcileSpend = vi.fn();
vi.mock("@/lib/supabase", () => ({ rawQuery: (...a: unknown[]) => rawQuery(...a) }));
vi.mock("@/lib/usage-store", async (importOriginal) => ({
  ...await importOriginal<typeof import("./usage-store")>(),
  reserveSpend: (...a: unknown[]) => reserveSpend(...a),
  reconcileSpend: (...a: unknown[]) => reconcileSpend(...a),
}));
vi.mock("@/lib/tenant", () => ({ resolveTenantId: async () => "tenant-a" }));
vi.mock("@/lib/secret-box", () => ({ open: () => "test-key" }));

import { withBudget } from "./metered";
import { billingScope } from "./billing-context";

let limits: unknown;
let spent: number;
let failedTable: string | null;
beforeEach(() => {
  vi.clearAllMocks();
  limits = { dailyCents: 100, monthlyCents: 500 };
  spent = 100;
  failedTable = null;
  rawQuery.mockImplementation(async (sql: string) => {
    if (failedTable && sql.includes(failedTable)) return { data: [], error: { message: "" } };
    if (sql.includes("tenant_api_keys")) return { data: [{ provider: "anthropic", model: null }], error: null };
    if (sql.includes("app_settings")) return { data: limits === undefined ? [] : [{ value: limits }], error: null };
    if (sql.includes("usage_counters")) return { data: [
      { period: new Date().toISOString().slice(0, 10), spent_cents: spent },
      { period: new Date().toISOString().slice(0, 7), spent_cents: spent },
    ], error: null };
    return { data: [], error: null };
  });
  reserveSpend.mockResolvedValue({ ok: true, spentCents: 10 });
  reconcileSpend.mockResolvedValue({});
});

// Mutation: keep the unconditional BYO bypass in withBudget.
test("a user's daily cap blocks work exactly at the limit", async () => {
  const fn = vi.fn(async () => "billed");
  const result = await withBudget({ action: "test", estimateCents: 10, isAdmin: false, fn });
  expect(result.capped).toContain("$1.00 daily");
  expect(result.capped).toContain("Settings");
  expect(fn).not.toHaveBeenCalled();
});

// Mutation: treat a null daily limit as disabling the monthly limit too.
test("a monthly-only cap blocks work on its own", async () => {
  limits = { dailyCents: null, monthlyCents: 100 };
  const fn = vi.fn(async () => "billed");
  const result = await withBudget({ action: "test", estimateCents: 1, isAdmin: false, fn });
  expect(result.capped).toContain("monthly");
  expect(fn).not.toHaveBeenCalled();
});

// Mutation: coerce zero into the absent limit branch.
test("a zero limit pauses calls before any spend", async () => {
  limits = { dailyCents: 0, monthlyCents: null };
  spent = 0;
  const fn = vi.fn(async () => "billed");
  expect((await withBudget({ action: "test", estimateCents: 0, isAdmin: false, fn })).capped).toContain("$0.00");
  expect(fn).not.toHaveBeenCalled();
});

// Mutation: invent a default limit for tenants who never selected one.
test("no saved limits means no app cap", async () => {
  limits = undefined;
  const result = await withBudget({ action: "test", estimateCents: 10000, isAdmin: false,
    fn: async () => billingScope()?.maxSearches });
  expect(result).toEqual({ result: null });
  expect(reserveSpend).not.toHaveBeenCalled();
});

// Mutation: skip atomic reservation for a BYO user below the cap.
test("a chosen cap reserves spend and passes a search cap into nested work", async () => {
  spent = 50;
  const result = await withBudget({ action: "test", estimateCents: 10, isAdmin: false,
    fn: async () => withBudget({ action: "nested", estimateCents: 10, isAdmin: false,
      fn: async () => billingScope()?.maxSearches }) });
  expect(result).toEqual({ result: { result: 50 } });
  expect(reserveSpend).toHaveBeenCalledTimes(1);
  expect(reserveSpend).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "tenant-a", dailyCeilingCents: 100, monthlyCeilingCents: 500 }));
  expect(reconcileSpend).toHaveBeenCalledWith(expect.objectContaining({ billedTo: "tenant", estimateCents: 10 }));
});

// Mutation: ignore failed reads and treat limits/spend as absent or zero.
test.each(["app_settings", "usage_counters"])("a failed %s read cannot unlock calls", async (table) => {
  failedTable = table;
  const fn = vi.fn(async () => "billed");
  const result = await withBudget({ action: "test", estimateCents: 10, isAdmin: false, fn });
  expect(result.error).toBeTruthy();
  expect(fn).not.toHaveBeenCalled();
});

// Mutation: malformed stored settings silently become unlimited.
test("invalid stored limits fail closed", async () => {
  limits = { dailyCents: "100", monthlyCents: 500 };
  const fn = vi.fn(async () => "billed");
  const result = await withBudget({ action: "test", estimateCents: 10, isAdmin: false, fn });
  expect(result.error).toBeTruthy();
  expect(fn).not.toHaveBeenCalled();
});

// Mutation: ignore a lost reservation race and execute anyway.
test("losing a concurrent monthly reservation prevents the call and names the month", async () => {
  spent = 0;
  reserveSpend.mockResolvedValue({ ok: false, spentCents: 0, reason: "monthly" });
  const fn = vi.fn(async () => "billed");
  const result = await withBudget({ action: "test", estimateCents: 10, isAdmin: false, fn });
  expect(result.capped).toContain("monthly");
  expect(fn).not.toHaveBeenCalled();
});
