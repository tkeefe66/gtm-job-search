import { afterEach, beforeEach, expect, test, vi } from "vitest";
const h=vi.hoisted(()=>({query:vi.fn(),spent:vi.fn(),limits:vi.fn(),reserve:vi.fn(),open:vi.fn()}));
vi.mock("./supabase",()=>({rawQuery:h.query}));
vi.mock("./secret-box",()=>({open:h.open}));
vi.mock("./usage-store",()=>({readSpent:h.spent,reserveSpend:h.reserve}));
vi.mock("./spend-limit-store",()=>({readSpendLimits:h.limits}));
import { readPaidSearchAvailability } from "./metered";
afterEach(()=>vi.unstubAllEnvs());

beforeEach(()=>{
  vi.clearAllMocks();
  h.query.mockResolvedValue({data:[{provider:"anthropic",model:"claude-sonnet-4-6"}],error:null});
  h.open.mockReturnValue("synthetic-key");
  h.spent.mockResolvedValue({spentCents:0});
  h.limits.mockResolvedValue({limits:{dailyCents:100,monthlyCents:500}});
});

test("readiness never reserves or spends money and respects the initial allowance boundary",async()=>{
  expect(await readPaidSearchAvailability("a",false)).toMatchObject({availableCents:100});
  h.spent.mockResolvedValue({spentCents:91});
  expect((await readPaidSearchAvailability("a",false)).blocked).toBeDefined();
  h.spent.mockResolvedValue({spentCents:90});
  expect((await readPaidSearchAvailability("a",false)).blocked).toBeUndefined();
  expect(h.reserve).not.toHaveBeenCalled();
});
test("missing and unreadable keys block paid search",async()=>{
  h.query.mockResolvedValue({data:[],error:null});
  expect((await readPaidSearchAvailability("a",false)).blocked).toContain("key");
  h.query.mockResolvedValue({data:[{provider:"anthropic",model:"claude-sonnet-4-6"}],error:null});
  h.open.mockReturnValue(null);
  expect((await readPaidSearchAvailability("a",false)).blocked).toContain("key");
});
test("admins may use a saved provider key without a platform fallback key",async()=>{
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  expect((await readPaidSearchAvailability("a",true)).blocked).toBeUndefined();
  h.query.mockResolvedValue({data:[],error:null});
  expect((await readPaidSearchAvailability("a",true)).blocked).toContain("key");
});
test("database failure is not represented as missing credentials or no spending",async()=>{
  h.query.mockResolvedValue({data:[],error:{message:""}});
  const key=await readPaidSearchAvailability("a",false);
  expect(key.error).toBeTruthy();expect(key.blocked).toBeUndefined();
  h.query.mockResolvedValue({data:[{provider:"anthropic",model:"claude-sonnet-4-6"}],error:null});
  h.spent.mockResolvedValue({error:""});
  const spending=await readPaidSearchAvailability("a",false);
  expect(spending.error).toBeTruthy();expect(spending.availableCents).toBeUndefined();
});
