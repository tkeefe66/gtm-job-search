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

import { scoreFit } from "./parse-role";
import { complete } from "@/lib/model-call";
import {
  DEFAULT_DOMAIN_BONUS,
  DEFAULT_MODERATE_TAIL,
  DEFAULT_STRONG_TAIL,
  DEFAULT_TITLE_SCOPE,
  DEFAULT_WEAK_FIT_TAIL,
} from "@/lib/fit-prompt";

const model = vi.mocked(complete);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
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
  const fitInputs = {
    fitBrain: "score this candidate",
    compFloor: null,
    weakFitTail: DEFAULT_WEAK_FIT_TAIL,
    moderateTail: DEFAULT_MODERATE_TAIL,
    strongTail: DEFAULT_STRONG_TAIL,
    titleScope: DEFAULT_TITLE_SCOPE,
    domainBonus: DEFAULT_DOMAIN_BONUS,
  };

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
