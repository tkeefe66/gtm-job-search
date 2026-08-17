import { beforeEach, describe, expect, test, vi } from "vitest";

// requireActor is mocked so each action's OWN failure reporting can be
// exercised without a real session — the guard existing on every action is
// pinned separately, unmocked, in app/actions/auth-required.test.ts.
vi.mock("@/lib/require-actor", () => ({
  requireActor: async () => ({
    userId: "test-user",
    tenantId: "test-user",
    email: "test@example.com",
    isAdmin: false,
  }),
}));

// The budget wrapper is replaced wholesale, not bypassed the way
// settings.test.ts bypasses it: generateProfile's whole contract is what it
// does with withBudget's three possible shapes (capped / error / result), so
// this suite drives that boundary directly rather than letting a real call
// reach Claude. Budget behaviour itself is pinned in lib/budget.test.ts.
vi.mock("@/lib/metered", () => ({ withBudget: vi.fn() }));

vi.mock("@/lib/supabase", () => ({
  rawQuery: vi.fn(),
  tenantTransaction: vi.fn(),
}));

// Only the two I/O writers are replaced; every pure reader (profileFrom,
// onboardedAtFrom, describeWriteFailure, the keys) stays real, the same shape
// settings.test.ts uses for writeCompScoringRescoredAt / writeSetting.
vi.mock("@/lib/settings-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings-store")>()),
  readAllSettingsResult: vi.fn(),
  writeProfile: vi.fn(),
}));

import { clearAnswers, generateProfile, getOnboardingState, saveAnswers, saveProfile } from "./onboarding";
import { withBudget } from "@/lib/metered";
import { rawQuery, tenantTransaction } from "@/lib/supabase";
import { readAllSettingsResult, writeProfile } from "@/lib/settings-store";
import { DEFAULT_PROFILE, resolveProfile, type OnboardingAnswers, type Profile } from "@/lib/profile";
import type { GeneratedProfile } from "@/lib/onboarding-prompt";

const budget = vi.mocked(withBudget);
const query = vi.mocked(rawQuery);
const transaction = vi.mocked(tenantTransaction);
const readSettings = vi.mocked(readAllSettingsResult);
const writeProf = vi.mocked(writeProfile);

const COMPLETE_ANSWERS: OnboardingAnswers = {
  mode: "questions",
  current: "Machinist",
  wanted: "CNC programmer",
  where: "Denver",
  dealbreakers: "",
  resume: "",
};

const VALID_PROFILE: Profile & GeneratedProfile = {
  ...resolveProfile({}),
  fitBrain: "- a machinist",
  titles: ["CNC Programmer"],
  locations: ["Denver"],
  stackTerms: ["Mastercam"],
  locationRule: "Only Denver.",
};

/**
 * What `saveProfile`'s transaction callback actually wrote, this test.
 *
 * `tenantTransaction` is mocked to RUN the real callback against this
 * recording `q` (rather than swallowing it, `mockResolvedValue(undefined)`
 * style) precisely so the callback's body has coverage: with a swallowed
 * callback, deleting one `put(...)` line inside saveProfile passes every test
 * green, which is exactly the partial-profile failure rule 4 exists to
 * prevent. See "writes every key a partial profile must never omit" below.
 */
let transactionCalls: { key: string; value: unknown }[] = [];

async function recordingQ(_text: string, values: unknown[] = []): Promise<{ rows: unknown[] }> {
  const [, key, rawValue] = values as [string, string, string];
  transactionCalls.push({ key, value: JSON.parse(rawValue) });
  return { rows: [] };
}

beforeEach(() => {
  budget.mockReset();
  query.mockReset();
  query.mockResolvedValue({ data: [], error: null } as never);
  transaction.mockReset();
  transactionCalls = [];
  transaction.mockImplementation(async (_tenantId, run) => run(recordingQ));
  readSettings.mockReset();
  readSettings.mockResolvedValue({ rows: [] });
  writeProf.mockReset();
  writeProf.mockResolvedValue({});
});

describe("getOnboardingState", () => {
  test("a read failure is reported, not rendered as an empty profile", async () => {
    readSettings.mockResolvedValue({ rows: [], error: "" });
    const res = await getOnboardingState();
    expect(res.error).toBeDefined();
    expect(res.answers).toEqual(DEFAULT_PROFILE.answers);
    expect(res.onboardedAt).toBeNull();
  });

  test("a clean read returns the stored answers and stamp", async () => {
    readSettings.mockResolvedValue({
      rows: [
        { key: "profile", value: { answers: { ...COMPLETE_ANSWERS } } },
        { key: "onboarded_at", value: "2026-08-01T00:00:00.000Z" },
      ],
    });
    const res = await getOnboardingState();
    expect(res.error).toBeUndefined();
    expect(res.answers.current).toBe("Machinist");
    expect(res.onboardedAt).toBe("2026-08-01T00:00:00.000Z");
  });
});

describe("saveAnswers — persisted BEFORE generation", () => {
  test("a read failure is reported and nothing is written", async () => {
    readSettings.mockResolvedValue({ rows: [], error: "" });
    const res = await saveAnswers(COMPLETE_ANSWERS);
    expect(res.error).toBeDefined();
    expect(writeProf).not.toHaveBeenCalled();
  });

  test("a write failure with no message is still reported", async () => {
    writeProf.mockResolvedValue({ error: "" });
    const res = await saveAnswers(COMPLETE_ANSWERS);
    expect(res.error).toBeDefined();
    expect(res.error).not.toMatch(/—\s*$/);
  });

  test("a clean save writes the answers into the profile document", async () => {
    const res = await saveAnswers(COMPLETE_ANSWERS);
    expect(res).toEqual({});
    expect(writeProf).toHaveBeenCalledTimes(1);
    const written = writeProf.mock.calls[0][0] as Profile;
    expect(written.answers.current).toBe("Machinist");
  });

  test("incomplete answers still save — completeness gates generation, not saving", async () => {
    const res = await saveAnswers({ ...DEFAULT_PROFILE.answers, mode: "questions" });
    expect(res).toEqual({});
    expect(writeProf).toHaveBeenCalledTimes(1);
  });
});

describe("generateProfile — metered, capped is a requirement not a failure", () => {
  test("incomplete answers are refused before any budget is reserved", async () => {
    const res = await generateProfile({ ...DEFAULT_PROFILE.answers, mode: "questions" });
    expect(res.error).toBeDefined();
    expect(budget).not.toHaveBeenCalled();
  });

  test("a capped budget is returned on its own key, not folded into error", async () => {
    budget.mockResolvedValue({ capped: "add a key" });
    const res = await generateProfile(COMPLETE_ANSWERS);
    expect(res.capped).toBe("add a key");
    expect(res.error).toBeUndefined();
    expect(res.profile).toBeUndefined();
  });

  test("a budget-layer failure (presence, not truthiness) is reported as a NON-EMPTY error", async () => {
    // lib/metered.ts propagates pg's raw message, which is "" when the
    // database is unreachable — onboarding is the first flow a brand-new
    // tenant meets, so an unwrapped budget.error would render a blank
    // failure banner on their very first screen. toBeDefined() alone would
    // have passed against that regression; this must assert non-empty.
    budget.mockResolvedValue({ error: "" });
    const res = await generateProfile(COMPLETE_ANSWERS);
    expect(res.error).toBeDefined();
    expect(res.error).not.toBe("");
    expect(res.error!.length).toBeGreaterThan(0);
    expect(res.capped).toBeUndefined();
  });

  test("a described budget-layer failure keeps the driver's own words", async () => {
    budget.mockResolvedValue({ error: "read-only transaction" });
    const res = await generateProfile(COMPLETE_ANSWERS);
    expect(res.error).toContain("read-only transaction");
  });

  test("a successful call returns the generated profile straight through", async () => {
    const profile = { fitBrain: "- a machinist" } as unknown as GeneratedProfile;
    budget.mockResolvedValue({ result: { profile } });
    const res = await generateProfile(COMPLETE_ANSWERS);
    expect(res.profile).toBe(profile);
    expect(res.capped).toBeUndefined();
    expect(res.error).toBeUndefined();
  });

  test("withBudget is invoked under the onboarding action name, for this tenant's admin flag", async () => {
    budget.mockResolvedValue({ result: { profile: {} as GeneratedProfile } });
    await generateProfile(COMPLETE_ANSWERS);
    expect(budget).toHaveBeenCalledTimes(1);
    expect(budget.mock.calls[0][0]).toMatchObject({ action: "onboarding", isAdmin: false });
  });
});

describe("saveProfile — validation, before the transaction ever runs", () => {
  test("an empty fit brain is refused before the transaction runs", async () => {
    const res = await saveProfile({ ...VALID_PROFILE, fitBrain: "   " });
    expect(res.error).toBeDefined();
    expect(transaction).not.toHaveBeenCalled();
  });

  test("an empty title list is refused before the transaction runs", async () => {
    const res = await saveProfile({ ...VALID_PROFILE, titles: [] });
    expect(res.error).toBeDefined();
    expect(transaction).not.toHaveBeenCalled();
  });

  test("an empty location list is refused before the transaction runs", async () => {
    const res = await saveProfile({ ...VALID_PROFILE, locations: [] });
    expect(res.error).toBeDefined();
    expect(transaction).not.toHaveBeenCalled();
  });

  test("an empty stack-terms list is refused before the transaction runs", async () => {
    // stackTerms is a ListSettingKey on /settings too (saveCriteriaList),
    // which rejects an empty list the same way — onboarding must match, or it
    // can write a value /settings itself can never re-save.
    const res = await saveProfile({ ...VALID_PROFILE, stackTerms: [] });
    expect(res.error).toBeDefined();
    expect(transaction).not.toHaveBeenCalled();
  });

  test("a whitespace-only location rule is refused before the transaction runs", async () => {
    const res = await saveProfile({ ...VALID_PROFILE, locationRule: "   " });
    expect(res.error).toBeDefined();
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("saveProfile — normalizes lists before writing them, never the raw model output", () => {
  test("titles and locations are trimmed, deduplicated, and case-folded", async () => {
    const res = await saveProfile({
      ...VALID_PROFILE,
      titles: ["CNC Programmer", "cnc programmer", " CNC  Machinist "],
      locations: [" Denver ", "denver"],
    });
    expect(res).toEqual({});
    const valueFor = (key: string) => transactionCalls.find((c) => c.key === key)?.value;
    expect(valueFor("titles")).toEqual(["CNC Programmer", "CNC Machinist"]);
    expect(valueFor("locations")).toEqual(["Denver"]);
  });

  test("stackTerms is normalized and locationRule is trimmed the same way", async () => {
    const res = await saveProfile({
      ...VALID_PROFILE,
      stackTerms: ["Mastercam", "mastercam", " Fanuc  Controls "],
      locationRule: "  Only Denver and nearby suburbs.  ",
    });
    expect(res).toEqual({});
    const valueFor = (key: string) => transactionCalls.find((c) => c.key === key)?.value;
    expect(valueFor("stackTerms")).toEqual(["Mastercam", "Fanuc Controls"]);
    expect(valueFor("locationRule")).toBe("Only Denver and nearby suburbs.");
  });
});

describe("saveProfile — one transaction, or none", () => {
  test("a failed transaction is reported, not silently swallowed", async () => {
    transaction.mockRejectedValue(new Error("deadlock detected"));
    const res = await saveProfile(VALID_PROFILE);
    expect(res.error).toBeDefined();
    expect(res.error).toContain("deadlock detected");
  });

  test("writes every key a partial profile must never omit", async () => {
    // The dedicated Finding-3 coverage test. Deleting the fitBrain `put(...)`
    // line inside saveProfile was verified to fail exactly this assertion —
    // see the fix report — which is what makes this coverage rather than
    // decoration: a tenant with titles but no fit brain is the partial-profile
    // failure rule 4 exists to prevent.
    const res = await saveProfile(VALID_PROFILE);
    expect(res).toEqual({});
    const keys = transactionCalls.map((c) => c.key);
    expect(keys).toEqual([
      "profile",
      "titles",
      "locations",
      "stackTerms",
      "locationRule",
      "fitBrain",
      "criteria_changed_at",
      "onboarded_at",
    ]);
  });

  test("a clean save clears exactly the caches cachesOnboardingClears names", async () => {
    const res = await saveProfile(VALID_PROFILE);
    expect(res).toEqual({});
    expect(transaction).toHaveBeenCalledTimes(1);
    const tables = query.mock.calls.map((c) => c[0] as string);
    expect(tables.some((sql) => sql.includes("delete from role_searches"))).toBe(true);
    expect(tables.some((sql) => sql.includes("delete from discovered_roles"))).toBe(true);
    // jobs is the user's pipeline, never a cache — see lib/onboarding-caches.ts.
    expect(tables.some((sql) => sql.includes("delete from jobs"))).toBe(false);
  });

  test("cache-clear failures are logged and non-fatal — the profile is already saved", async () => {
    query.mockResolvedValue({ data: [], error: { message: "boom" } } as never);
    const res = await saveProfile(VALID_PROFILE);
    expect(res).toEqual({});
  });
});

describe("clearAnswers", () => {
  test("a read failure is reported and nothing is written", async () => {
    readSettings.mockResolvedValue({ rows: [], error: "" });
    const res = await clearAnswers();
    expect(res.error).toBeDefined();
    expect(writeProf).not.toHaveBeenCalled();
  });

  test("a write failure is reported", async () => {
    writeProf.mockResolvedValue({ error: "" });
    const res = await clearAnswers();
    expect(res.error).toBeDefined();
  });

  test("a clean clear resets only the answers, leaving the rest of the profile", async () => {
    readSettings.mockResolvedValue({
      rows: [{ key: "profile", value: { fitBrain: "kept", answers: { ...COMPLETE_ANSWERS } } }],
    });
    const res = await clearAnswers();
    expect(res).toEqual({});
    const written = writeProf.mock.calls[0][0] as Profile;
    expect(written.fitBrain).toBe("kept");
    expect(written.answers).toEqual(DEFAULT_PROFILE.answers);
  });
});
