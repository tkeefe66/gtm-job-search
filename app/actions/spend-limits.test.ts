import { beforeEach, expect, test, vi } from "vitest";
const rawQuery = vi.fn();
const requireActor = vi.fn();
vi.mock("@/lib/supabase", () => ({ rawQuery: (...a: unknown[]) => rawQuery(...a) }));
vi.mock("@/lib/require-actor", () => ({ requireActor: () => requireActor() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { saveSpendLimits } from "./spend-limits";

beforeEach(() => {
  vi.clearAllMocks();
  requireActor.mockResolvedValue({ tenantId: "tenant-a", isAdmin: false });
  rawQuery.mockResolvedValue({ data: [], error: null });
});

// Mutation: accept a supplied tenant ID as the row owner or omit tenant scope.
test("saving limits uses the authenticated tenant even if the payload names another", async () => {
  const result = await saveSpendLimits({ dailyCents: 250, monthlyCents: 1000, tenantId: "tenant-b" } as never);
  expect(result).toEqual({});
  const [sql, args, scope] = rawQuery.mock.calls[0];
  expect(sql).toContain("insert into app_settings");
  expect(args).toEqual(["tenant-a", "spend_limits", JSON.stringify({ dailyCents: 250, monthlyCents: 1000 })]);
  expect(scope).toBe("tenant-a");
});

// Mutation: stringify the whole unvalidated payload or coerce invalid values.
test.each([
  { dailyCents: -1, monthlyCents: 100 },
  { dailyCents: NaN, monthlyCents: null },
  { dailyCents: Infinity, monthlyCents: null },
  { dailyCents: 1.5, monthlyCents: null },
  { dailyCents: "100", monthlyCents: null },
  { dailyCents: 200, monthlyCents: 100 },
  { dailyCents: 100000001, monthlyCents: null },
  { monthlyCents: null },
  null,
])("invalid limits are rejected before a write: %j", async (limits) => {
  expect((await saveSpendLimits(limits as never)).error).toBeTruthy();
  expect(rawQuery).not.toHaveBeenCalled();
});

// Mutation: disallow zero caps or require both windows to be set.
test.each([{ dailyCents: 0, monthlyCents: null }, { dailyCents: null, monthlyCents: 0 }, { dailyCents: null, monthlyCents: null }])(
  "zero and unset have distinct valid meanings: %j", async (limits) => {
    expect(await saveSpendLimits(limits)).toEqual({});
    expect(rawQuery.mock.calls[0][1][2]).toBe(JSON.stringify(limits));
  }
);

// Mutation: if(error.message) makes a failed save look successful.
test("an empty database error does not acknowledge a save", async () => {
  rawQuery.mockResolvedValue({ data: [], error: { message: "" } });
  expect((await saveSpendLimits({ dailyCents: 100, monthlyCents: null })).error).toContain("unreachable");
});

// Mutation: allow an admin to write an ignored second source of limits.
test("admin settings direct edits to the existing Accounts control", async () => {
  requireActor.mockResolvedValue({ tenantId: "admin", isAdmin: true });
  expect((await saveSpendLimits({ dailyCents: 100, monthlyCents: 1000 })).error).toContain("Accounts");
  expect(rawQuery).not.toHaveBeenCalled();
});
