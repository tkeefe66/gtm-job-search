// app/actions/resume-model-failure.test.ts
//
// Pins the fix for finding #3 of the 2026-08-25 whole-branch review:
// deriveThemes (app/actions/resume.ts) used to catch EVERY failure from the
// theme-derivation model call — auth, network, rate limit, an unparseable
// response — and return an empty theme list in every case, indistinguishable
// from the model legitimately finding no matching themes. tailorResumeForJob
// then wrote a tailored_resumes row that looked like a completed tailoring,
// with the user given no signal anything went wrong.
//
// This is a separate file from resume.test.ts (same split as parse-role.test.ts
// / parse-role-empty-brain.test.ts) because it needs an ADMIN actor and a
// mocked model-call/supabase layer, which would conflict with resume.test.ts's
// non-admin auth-refusal mocks in the same module scope.
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/require-actor", () => ({
  requireActor: async () => ({
    userId: "admin-1",
    tenantId: "admin-1",
    email: "admin@example.com",
    isAdmin: true,
  }),
}));

// Bypassed for the same reason parse-role.test.ts and roles.test.ts bypass it:
// this suite is about deriveThemes' own failure reporting, and withBudget
// reaches the database for tiers/counters before fn ever runs. Budget
// behaviour itself is pinned in lib/budget.test.ts.
vi.mock("@/lib/metered", () => ({
  withBudget: async (o: { fn: () => Promise<unknown> }) => ({ result: await o.fn() }),
}));

vi.mock("@/lib/model-call", () => ({
  complete: vi.fn(),
  parseJson: (raw: string) => JSON.parse(raw),
}));

// Tracks whether the tailored_resumes upsert ever ran, which is the whole
// point of the test: a model-call failure must refuse BEFORE that write.
const h = vi.hoisted(() => {
  const state = { upsertCalled: false };
  const jobRow = {
    role_title: "VP RevOps",
    company: "Acme",
    key_skills: null,
    fit_summary: null,
    seniority: null,
    department: null,
    salary_range: null,
    company_description: null,
  };
  function makeBuilder(table: string) {
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = () => b;
    b.maybeSingle = () =>
      Promise.resolve({ data: table === "jobs" ? jobRow : null, error: null });
    b.upsert = () => {
      state.upsertCalled = true;
      return Promise.resolve({ data: [], error: null });
    };
    return b;
  }
  return { state, makeBuilder, jobRow };
});

vi.mock("@/lib/supabase", () => ({
  supabase: {
    forTenant: () => ({ from: (table: string) => h.makeBuilder(table) }),
  },
}));

import { tailorResumeForJob } from "./resume";
import { complete } from "@/lib/model-call";

const model = vi.mocked(complete);

beforeEach(() => {
  vi.clearAllMocks();
  h.state.upsertCalled = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("tailorResumeForJob when the theme-derivation call fails", () => {
  test("returns an {error} and never writes a tailored_resumes row", async () => {
    model.mockRejectedValue(new Error("rate limited"));

    const res = await tailorResumeForJob("11111111-1111-1111-1111-111111111111");

    expect(res.error).toBeDefined();
    expect(res.error).not.toBe("");
    expect(res.selection).toBeNull();
    expect(res.themes).toEqual([]);
    expect(h.state.upsertCalled).toBe(false);
  });

  test("an empty-but-valid theme list (the model ran fine, found nothing) is NOT treated as a failure", async () => {
    model.mockResolvedValue(JSON.stringify({ themes: [] }));

    const res = await tailorResumeForJob("11111111-1111-1111-1111-111111111111");

    expect(res.error).toBeUndefined();
    expect(res.selection).not.toBeNull();
    expect(h.state.upsertCalled).toBe(true);
  });
});
