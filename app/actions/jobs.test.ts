import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Job } from "@/lib/types";

// The session guard is mocked, not exercised: these tests are about getJobs'
// own read/partition behaviour, and requireActor() would otherwise throw
// before any of that ran. That the guard EXISTS is asserted separately in
// app/actions/auth-required.test.ts — mocking it here would otherwise quietly
// delete that coverage.
vi.mock("@/lib/require-actor", () => ({
  requireActor: async () => ({
    userId: "test-user",
    tenantId: "test-user",
    email: "test@example.com",
    isAdmin: false,
  }),
}));

vi.mock("@/lib/tenant", () => ({
  resolveTenantId: async () => "00000000-0000-0000-0000-000000000001",
}));

// Same harness lesson as app/actions/roles.test.ts: mock the edges, keep the
// decision. getJobs' chain is select().order() only — nothing here ever
// switches this builder into "write" mode.
const h = vi.hoisted(() => {
  const state = {
    readResult: { data: null as unknown, error: null as { message: string } | null },
  };
  const makeBuilder = () => {
    const b: Record<string, unknown> = {};
    const chain = () => b;
    for (const m of ["select", "eq", "order", "limit", "single", "maybeSingle"]) {
      b[m] = chain;
    }
    b.then = (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) =>
      Promise.resolve(state.readResult).then(ok, err);
    return b;
  };
  return { state, makeBuilder };
});

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: () => h.makeBuilder(),
    forTenant: () => ({ from: () => h.makeBuilder() }),
  },
  rawQuery: vi.fn(),
}));

import { getJobs } from "./jobs";

// Only the two fields getJobs' partition reads, plus id — same fixture
// discipline as lib/never-live.test.ts: a full 30-field Job would obscure
// what each case varies.
const job = (id: string, never_live: unknown): Job =>
  ({ id, company: "Clay", role_title: "RevOps Manager", never_live }) as unknown as Job;

beforeEach(() => {
  h.state.readResult = { data: null, error: null };
});

describe("getJobs", () => {
  // Mutation caught: deleting the partitionNeverLive call and returning the
  // rows straight through — the never_live row would surface in `jobs` and
  // hiddenCount would read 0.
  test("drops never_live rows and reports the count", async () => {
    h.state.readResult = {
      data: [job("a", false), job("b", true), job("c", false)],
      error: null,
    };

    const res = await getJobs();

    expect(res.jobs.map((j) => j.id)).toEqual(["a", "c"]);
    expect(res.hiddenCount).toBe(1);
    expect(res.error).toBeUndefined();
  });

  // Mutation caught: partitionNeverLive's `!== true` becoming `=== false` (or
  // a truthiness check) — a row with no never_live key at all would then be
  // treated the same as an absent key WOULD under truthiness (dropped),
  // rather than staying visible.
  test("a row whose never_live key is absent stays visible", async () => {
    const rowWithNoKey = { id: "a", company: "Clay", role_title: "RevOps Manager" } as Job;
    h.state.readResult = {
      data: [rowWithNoKey, job("b", false)],
      error: null,
    };

    const res = await getJobs();

    expect(res.jobs.map((j) => j.id)).toEqual(["a", "b"]);
    expect(res.hiddenCount).toBe(0);
  });

  // Mutation caught: the error path inventing a fallback string instead of
  // passing the driver's message through verbatim, or returning a non-zero
  // hiddenCount on a failed read. Empty string is not hypothetical here — see
  // lib/write-failure.ts: pg's AggregateError has message "" and is exactly
  // what an unreachable DATABASE_URL produces.
  test("a failed read returns hiddenCount 0 and the driver's message verbatim", async () => {
    h.state.readResult = { data: null, error: { message: "" } };

    const res = await getJobs();

    expect(res.jobs).toEqual([]);
    expect(res.hiddenCount).toBe(0);
    expect(res.error).toBe("");
  });
});
