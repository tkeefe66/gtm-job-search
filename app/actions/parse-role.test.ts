import { beforeEach, describe, expect, test, vi } from "vitest";

// The budget wrapper is bypassed: this suite asserts that a FAILED parse always
// carries a message, and withBudget reaches the database for tiers and counters
// before the parse runs. Budget behaviour is pinned in lib/budget.test.ts.
vi.mock("@/lib/metered", () => ({
  withBudget: async (o: { fn: () => Promise<unknown> }) => ({ result: await o.fn() }),
}));


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


// Mock the edges, keep the decision (app/actions/roles.test.ts has the same
// harness note). Only parseJobUrl's catch path is under test here, so the
// Claude client is the single edge that has to move.
vi.mock("@/lib/anthropic", () => ({
  callWithWebSearch: vi.fn(),
  anthropic: {},
  MODEL: "claude-sonnet-4-6",
  parseJson: (raw: string) => JSON.parse(raw),
}));
vi.mock("@/lib/search-criteria", () => ({ loadScoringInputs: vi.fn() }));
vi.mock("@/lib/usage.js", () => ({ report: vi.fn() }));

import { parseJobUrl, parseRecruiterText } from "./parse-role";
import { callWithWebSearch } from "@/lib/anthropic";

const search = vi.mocked(callWithWebSearch);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// The caller is `if (res.error)` in components/RolesTable.tsx. An empty
// message is falsy, so a failure that arrives without text is read as a
// success: the form advances to the review step with nothing filled in and no
// error shown. Node's AggregateError — the empty-message case documented in
// lib/write-failure.ts — is exactly what a connection failure to the API
// rejects with, so this is a live path, not a hypothetical one.
describe("parseJobUrl always returns a message when it failed", () => {
  test("a thrown Error with a message passes that message through", async () => {
    search.mockRejectedValue(new Error("529 overloaded"));

    const res = await parseJobUrl("https://example.com/jobs/1");

    expect(res.error).toBe("529 overloaded");
  });

  test("a thrown Error with an EMPTY message still reports a failure", async () => {
    search.mockRejectedValue(new Error(""));

    const res = await parseJobUrl("https://example.com/jobs/1");

    expect(res.error).toBeTruthy();
  });

  test("a non-Error throw reports a failure", async () => {
    search.mockRejectedValue("nope");

    const res = await parseJobUrl("https://example.com/jobs/1");

    expect(res.error).toBeTruthy();
  });

  test("a successful parse reports no error", async () => {
    search.mockResolvedValue(JSON.stringify({ company: "Clay" }));

    const res = await parseJobUrl("https://example.com/jobs/1");

    expect(res.error).toBeUndefined();
    expect(res.role?.company).toBe("Clay");
  });
});

// The same defect, the same file, a different caller:
// components/RecruiterPanel.tsx:59 reads this one with `if (res.error)`.
describe("parseRecruiterText always returns a message when it failed", () => {
  test("a thrown Error with an EMPTY message still reports a failure", async () => {
    search.mockRejectedValue(new Error(""));

    const res = await parseRecruiterText("pasted recruiter email");

    expect(res.error).toBeTruthy();
  });

  test("a successful parse reports no error", async () => {
    search.mockResolvedValue(JSON.stringify({ company: "Clay" }));

    const res = await parseRecruiterText("pasted recruiter email");

    expect(res.error).toBeUndefined();
    expect(res.role?.company).toBe("Clay");
  });
});
