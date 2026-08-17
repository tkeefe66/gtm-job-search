import { beforeEach, describe, expect, test, vi } from "vitest";

// The session guard is mocked, not exercised: these tests are about each
// action's own failure reporting, and requireActor() would otherwise throw
// before any of that ran. That the guard EXISTS on every action is asserted
// separately, in app/actions/auth-required.test.ts — mocking it here would
// otherwise quietly delete that coverage.
vi.mock("@/lib/require-actor", () => ({
  requireActor: async () => ({
    userId: "test-user",
    tenantId: "test-user",
    email: "test@example.com",
    isAdmin: false,
  }),
}));


// Same harness lesson as app/actions/settings.test.ts and
// app/actions/watchlist.test.ts: mock the edges, keep the decision.
// findAndSaveRoles reaches Claude, the database and the ingest path, and all
// three are replaced here — what is left is the cache-failure reporting, which
// is the whole of fix #2 on the UNCAPPED search path.
const h = vi.hoisted(() => {
  const state = {
    readResult: { data: null as unknown, error: null as { message: string } | null },
    writeResult: { data: [] as unknown, error: null as { message: string } | null },
  };
  const makeBuilder = () => {
    const b: Record<string, unknown> = {};
    // A read chain ends in .maybeSingle(); a write chain ends in .upsert().
    // Which result to hand back is decided by whichever was called last.
    let mode: "read" | "write" = "read";
    const chain = () => b;
    for (const m of ["select", "eq", "order", "limit", "single", "maybeSingle", "delete"]) {
      b[m] = chain;
    }
    for (const op of ["insert", "update", "upsert"]) {
      b[op] = () => {
        mode = "write";
        return b;
      };
    }
    b.then = (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) =>
      Promise.resolve(mode === "write" ? state.writeResult : state.readResult).then(ok, err);
    return b;
  };
  return { state, makeBuilder };
});

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: () => h.makeBuilder(),
    // Same builder either way — this suite asserts what the ACTION does, not
    // what the transport adds. That tenant tables are only reachable through
    // forTenant is enforced in lib/supabase.ts and pinned in its own test.
    forTenant: () => ({ from: () => h.makeBuilder() }),
  },
}));
vi.mock("@/lib/tenant", () => ({
  resolveTenantId: async () => "00000000-0000-0000-0000-000000000001",
}));
vi.mock("@/lib/anthropic", () => ({
  callWithWebSearch: vi.fn(),
  parseJson: (raw: string) => JSON.parse(raw),
}));
vi.mock("@/lib/ingest-roles", () => ({ ingestRoles: vi.fn() }));
vi.mock("@/lib/search-criteria", () => ({
  ROLE_SEARCH_SYSTEM: "system",
  loadCriteriaAndScoringInputs: vi.fn(async () => ({
    criteria: { titles: ["RevOps"], locationRule: "remote" },
    fitInputs: {},
  })),
  roleExtractionSchema: () => "schema",
  titleListForPrompt: () => "RevOps",
}));

import { findAndSaveRoles } from "./roles";
import { callWithWebSearch } from "@/lib/anthropic";
import type { Startup } from "@/lib/types";

const search = vi.mocked(callWithWebSearch);

const STARTUP: Startup = {
  company: "Clay",
  tagline: "GTM data",
  raised: "$46M",
  stage: "Series B",
  category: "GTM",
  lead_investor: "Sequoia",
  founded: "2021",
  traction: "3x YoY",
  careers_url: "",
  headquarters: "New York, NY",
};

const ONE_ROLE = JSON.stringify([
  { role_title: "RevOps Lead", job_url: "https://x.example/1", location: "Remote" },
]);

beforeEach(() => {
  search.mockReset();
  search.mockResolvedValue(ONE_ROLE);
  // No cached row, so the billed search runs.
  h.state.readResult = { data: null, error: null };
  h.state.writeResult = { data: [], error: null };
});

describe("findAndSaveRoles reports a cache write it could not do", () => {
  test("a clean run returns the roles and NO warning", async () => {
    // Positive control. Without it, "always warn" passes everything below.
    const res = await findAndSaveRoles(STARTUP, true);
    expect(res.roles).toHaveLength(1);
    expect(res.cacheWarning).toBeUndefined();
    expect(res.error).toBeUndefined();
  });

  test("a failed cache write is reported on cacheWarning, NOT on error", async () => {
    // M34. `error` means "the search failed" to Discover's handleFindRoles,
    // which returns early — so folding this into `error` would discard roles
    // that were found, ingested, and PAID FOR on an uncapped search.
    h.state.writeResult = { data: [], error: { message: 'relation "discovered_roles" does not exist' } };
    const res = await findAndSaveRoles(STARTUP, true);
    expect(res.error).toBeUndefined();
    expect(res.cacheWarning).toBeDefined();
    expect(res.roles).toHaveLength(1);
  });

  test("M35: the warning is not silently dropped", async () => {
    h.state.writeResult = { data: [], error: { message: "boom" } };
    const res = await findAndSaveRoles(STARTUP, true);
    expect(res.cacheWarning).toBeDefined();
    // And it carries the one detail that gets the user unstuck.
    expect(res.cacheWarning).toContain("node db/apply-schema.mjs");
  });

  test("a cache write that failed with NO message still warns", async () => {
    // The empty-message class at this call site: `if (cacheError)` is on the
    // error OBJECT here, so presence holds — but the MESSAGE still has to be
    // substituted or the warning trails off after a dash.
    h.state.writeResult = { data: [], error: { message: "" } };
    const res = await findAndSaveRoles(STARTUP, true);
    expect(res.cacheWarning).toBeDefined();
    expect(res.cacheWarning).not.toMatch(/—\s*\./);
  });
});
