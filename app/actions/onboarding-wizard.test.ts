import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({tenant: "tenant-a", store: new Map<string, unknown>(), companies: [{company: "Big  Co", careers_url: "https://big.example/original"}], fail: false, failCompany: false, writes: [] as {sql: string; values: unknown[]}[]}));
vi.mock("@/lib/require-actor", () => ({requireActor: vi.fn(async () => ({tenantId: state.tenant, isAdmin: false}))}));
vi.mock("@/lib/tenant", () => ({resolveTenantId: async () => state.tenant}));
vi.mock("@/lib/model-call", () => ({callStructured: vi.fn(), parseJson: JSON.parse}));
vi.mock("@/lib/metered", () => ({withBudget: vi.fn()}));
vi.mock("@/lib/supabase", () => ({
  rawQuery: vi.fn(async (sql: string, values: unknown[], tenant: string) => {
    expect(values[0]).toBe(tenant);
    if (state.fail) return {error: {message: ""}};
    if (sql.startsWith("delete")) return {data: []};
    if (sql.includes("and key=")) return {data: state.store.has(`${tenant}:${values[1]}`) ? [{value: state.store.get(`${tenant}:${values[1]}`)}] : []};
    return {data: Array.from(state.store.entries()).filter(([k]) => k.startsWith(`${tenant}:`)).map(([k,value]) => ({key: k.slice(tenant.length+1), value}))};
  }),
  tenantTransaction: vi.fn(async (tenant: string, run: (q: (sql: string, values?: unknown[]) => Promise<{rows: Record<string, unknown>[]}>) => Promise<unknown>) => {
    if (state.fail) throw new Error("");
    const before = new Map(state.store);
    try { return await run(async (sql, values = []) => {
      state.writes.push({sql, values});
      if (sql.includes("pg_advisory")) return {rows: []};
      expect(values[0]).toBe(tenant);
      if (sql.startsWith("select value")) return {rows: state.store.has(`${tenant}:${values[1]}`) ? [{value: state.store.get(`${tenant}:${values[1]}`)}] : []};
      if (sql.startsWith("select company")) return {rows: state.companies};
      if (sql.startsWith("insert into watchlist")) {if (state.failCompany) throw new Error("company write failed"); return {rows: []};}
      if (sql.startsWith("insert into app_settings")) state.store.set(`${tenant}:${values[1]}`, JSON.parse(values[2] as string));
      if (sql.startsWith("delete from app_settings")) state.store.delete(`${tenant}:${values[1]}`);
      return {rows: []};
    }); } catch (e) {state.store = before; throw e;}
  }),
}));
import { withBudget } from "@/lib/metered";
import { callStructured } from "@/lib/model-call";
import { emptyWizardAnswers, WIZARD_DRAFT_KEY, type WizardDraft } from "@/lib/onboarding-wizard";
import { DEFAULT_PROFILE } from "@/lib/profile";
import { clearWizardProgress, finishWizardOnboarding, generateWizardProfile, getWizardState, saveWizardProgress } from "./onboarding-wizard";

const answers = () => ({...emptyWizardAnswers(), current: "Nurse", wanted: "Charge nurse", location: "Boston"});
const result = () => ({...DEFAULT_PROFILE, fitBrain: "- Nurse seeking charge nurse work", titles: ["Charge nurse"], locations: ["Boston"], stackTerms: [], locationRule: "Boston only"});
beforeEach(() => {
  vi.clearAllMocks(); state.tenant = "tenant-a"; state.store = new Map(); state.fail = false; state.failCompany = false; state.writes = [];
  vi.mocked(callStructured).mockResolvedValue(JSON.stringify(result()));
  vi.mocked(withBudget).mockImplementation(async opts => ({result: await opts.fn()}));
});
describe("persisted wizard generation", () => {
  it("keeps active profile unchanged until finish and retains generated review on refresh and navigation", async () => {
    state.store.set("tenant-a:profile", {fitBrain: "Original"});
    const a = answers();
    expect(await generateWizardProfile(a)).toHaveProperty("profile");
    expect(state.store.get("tenant-a:profile")).toEqual({fitBrain: "Original"});
    expect(await saveWizardProgress(a, 10)).toEqual({});
    expect((await getWizardState()).draft.generated?.fitBrain).toContain("Nurse");
    expect(await finishWizardOnboarding(a)).toEqual({});
    expect(state.store.get("tenant-a:onboarded_at")).toBeTypeOf("string");
    expect(state.store.get("tenant-a:fitBrain")).toContain("Nurse");
    expect(state.writes).toContainEqual({sql: "delete from discovered_startups where tenant_id=$1", values: ["tenant-a"]});
  });
  it("invalidates an edited generation and refuses a client trying to finish the older answers", async () => {
    const a = answers(); await generateWizardProfile(a);
    await saveWizardProgress({...a, wanted: "Different work"}, 1);
    expect((await finishWizardOnboarding(a)).error).toContain("Generate");
    expect(state.store.has("tenant-a:profile")).toBe(false);
  });
  it("does not save a result when answers change during the billed call", async () => {
    const a = answers();
    vi.mocked(callStructured).mockImplementation(async () => {await saveWizardProgress({...a, wanted: "Different work"}, 1); return JSON.stringify(result());});
    expect((await generateWizardProfile(a)).error).toContain("changed while generating");
    expect((await getWizardState()).draft.generated).toBeUndefined();
  });
  it("does not bypass the BYO-key cap or make a model call on save/read", async () => {
    vi.mocked(withBudget).mockResolvedValue({capped: "Add your API key"});
    await saveWizardProgress(answers(), 4); await getWizardState();
    expect(await generateWizardProfile(answers())).toEqual({capped: "Add your API key"});
    expect(callStructured).not.toHaveBeenCalled();
    expect(withBudget).toHaveBeenCalledWith(expect.objectContaining({isAdmin: false, action: "onboarding"}));
  });
  it("retains a valid completed generation when an explicit retry is capped", async () => {
    const a = answers(); await generateWizardProfile(a);
    vi.mocked(withBudget).mockResolvedValue({capped: "Daily budget reached"});
    expect((await generateWizardProfile(a)).capped).toBeDefined();
    const current = await getWizardState();
    expect(current.draft.generated?.fitBrain).toContain("Nurse");
    expect(current.draft.step).toBe(10);
    expect(await finishWizardOnboarding(a)).toEqual({});
  });
  it("rejects malformed and conflicting inputs before reserving budget", async () => {
    expect((await generateWizardProfile({...answers(), compFloor: "-100"})).error).toContain("positive");
    expect((await generateWizardProfile({...answers(), companies: [{name: "https://example.com/jobs", careersUrl: ""}]})).error).toContain("company name");
    expect(withBudget).not.toHaveBeenCalled();
  });
  it("detects empty database errors for reads, writes and metering", async () => {
    state.fail = true;
    expect((await getWizardState()).error).toContain("unreachable");
    expect((await saveWizardProgress(answers(), 0)).error).toContain("unreachable");
    state.fail = false;
    vi.mocked(withBudget).mockResolvedValue({error: ""});
    expect((await generateWizardProfile(answers())).error).toContain("unreachable");
  });
  it("scopes drafts by authenticated tenant", async () => {
    await generateWizardProfile(answers()); state.tenant = "tenant-b";
    expect((await getWizardState()).draft.generated).toBeUndefined();
    expect((await finishWizardOnboarding(answers())).error).toBeTruthy();
    expect(state.store.has(`tenant-a:${WIZARD_DRAFT_KEY}`)).toBe(true);
  });
  it("rejects an incomplete model profile instead of repairing career defaults", async () => {
    vi.mocked(callStructured).mockResolvedValue(JSON.stringify({fitBrain: "Nurse", titles: ["Nurse"]}));
    expect((await generateWizardProfile(answers())).error).toContain("generation failed");
    expect((await getWizardState()).draft.generated).toBeUndefined();
  });
  it("preserves existing company spelling and URL, and rolls back finish if a company fails", async () => {
    const a = {...answers(), companies: [{name: "big co", careersUrl: "https://big.example/new"}]};
    await generateWizardProfile(a); state.failCompany = true;
    expect((await finishWizardOnboarding(a)).error).toContain("company write failed");
    expect(state.store.has("tenant-a:onboarded_at")).toBe(false);
    expect((state.store.get(`tenant-a:${WIZARD_DRAFT_KEY}`) as WizardDraft).generated).toBeDefined();
    state.failCompany = false; expect(await finishWizardOnboarding(a)).toEqual({});
    expect(state.writes.find(w => w.sql.startsWith("insert into watchlist"))?.values).toEqual(["tenant-a", "Big  Co", "https://big.example/original"]);
    expect(callStructured).toHaveBeenCalledTimes(1);
  });
  it("hydrates legacy source without clipping resumes and clearing stays clear after refresh", async () => {
    state.store.set("tenant-a:profile", {answers: {current: "Nurse", where: "Boston", resume: "a".repeat(18000)}});
    expect((await getWizardState()).draft.answers.resume).toHaveLength(18000);
    await clearWizardProgress();
    expect((await getWizardState()).draft.answers.current).toBe("");
    expect((state.store.get("tenant-a:profile") as {answers: {current: string}}).answers.current).toBe("Nurse");
  });
});
