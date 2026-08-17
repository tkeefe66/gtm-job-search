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
// harness note). The facade is the single edge every model call in this module
// goes through, so it is the only one that has to move.
vi.mock("@/lib/model-call", () => ({
  callWithWebSearch: vi.fn(),
  complete: vi.fn(),
  parseJson: (raw: string) => JSON.parse(raw),
}));
vi.mock("@/lib/search-criteria", () => ({ loadScoringInputs: vi.fn() }));

import { parseJobUrl, parseRecruiterText, scoreFit } from "./parse-role";
import { callWithWebSearch, complete } from "@/lib/model-call";

const search = vi.mocked(callWithWebSearch);
const model = vi.mocked(complete);

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

describe("scoreFit runs through the provider registry, not the raw SDK", () => {
  // The real FitPromptRole (lib/fit-prompt.ts:30) — every non-optional field,
  // because scoreFit's parameter type is that interface and a partial will not
  // compile. salary_range is "" when the posting published none, never null.
  const role = {
    company: "Acme",
    role_title: "VP RevOps",
    company_description: "Series B GTM analytics",
    key_skills: "Salesforce, dbt",
    fit_summary: "close",
    department: "Revenue Operations",
    location: "Denver, CO",
    salary_range: "$220K–$260K (base)",
  };
  const fitInputs = { fitBrain: "score this candidate", compFloor: null };

  test("a score comes back through the facade", async () => {
    model.mockResolvedValue(JSON.stringify({ score: 4, rationale: "close fit" }));
    const res = await scoreFit({ ...role, fitInputs });
    expect(res).toMatchObject({ score: 4, rationale: "close fit" });
  });

  test("the model is not named at the call site — routing is the scope's job", async () => {
    model.mockResolvedValue(JSON.stringify({ score: 3, rationale: "" }));
    await scoreFit({ ...role, fitInputs });
    expect(model.mock.calls[0][0]).not.toHaveProperty("model");
  });

  // The empty-string rule: a failure that is not the database substitutes its
  // own sentence, because UNDESCRIBED_DB_ERROR names the database and would be
  // a false sentence here.
  test("a model failure with an empty message still returns a sentence", async () => {
    model.mockRejectedValue(new Error(""));
    const res = await scoreFit({ ...role, fitInputs });
    expect(res.error).not.toBe("");
    expect(res.error).toBeTruthy();
    expect(res.score).toBe(0);
  });

  // The other half of the same rule: the sentence is a CLOSED SET, so the SDK's
  // text never reaches the browser. Now that validateKey probes the tenant's
  // chosen model, a `model: not_found_error` — which carries the request URL,
  // and sometimes the key — is the likeliest thing to be thrown here.
  test("the SDK's text is never passed through, only a fixed sentence", async () => {
    model.mockRejectedValue(
      new Error("404 https://api.anthropic.com/v1/messages model: not_found_error key=sk-ant-leak")
    );
    const res = await scoreFit({ ...role, fitInputs });
    expect(res.error).toBe("Failed to score fit.");
    expect(res.error).not.toContain("sk-ant-leak");
    expect(res.error).not.toContain("api.anthropic.com");
  });
});
