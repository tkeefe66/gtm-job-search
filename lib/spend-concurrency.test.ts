import { beforeEach, expect, test, vi } from "vitest";
let spent = 0;
let onRead: (() => Promise<void>) | undefined;
const providerCall = vi.fn();
vi.mock("@/lib/tenant", () => ({ resolveTenantId: async () => "tenant-a" }));
vi.mock("@/lib/secret-box", () => ({ open: () => "test-key" }));
vi.mock("@/lib/supabase", () => ({ rawQuery: async (sql: string) => ({ data:
  sql.includes("tenant_api_keys") ? [{provider:"anthropic",model:null}] : [], error:null }) }));
vi.mock("@/lib/spend-limit-store", () => ({ readSpendLimits: async () => ({ limits:{dailyCents:100,monthlyCents:500} }) }));
vi.mock("@/lib/usage-store", () => ({
  readSpent: async () => {
    const value = spent;
    if (onRead) { const hook = onRead; onRead = undefined; await hook(); }
    return {spentCents:value};
  },
  advanceSpend: async ({deltaCents}: {deltaCents:number}) => { spent += deltaCents; return {}; },
  reserveSpend: async ({estimateCents}: {estimateCents:number}) => {
    spent += estimateCents;
    return {ok:true, spentCents:estimateCents, availableCents:100-spent+estimateCents};
  },
  reconcileSpend: async ({estimateCents,actualCents}: {estimateCents:number;actualCents:number}) => {
    spent += actualCents-estimateCents;return {};
  },
}));
vi.mock("@/lib/providers/registry", () => ({providerFor:()=>({
  id:"anthropic",searchCapEnforcement:"in-request", defaultModel:"test", pricedModels:["test"],
  costCents:(u:{inputTokens:number;searches:number})=>u.inputTokens+u.searches,
  complete:(...args:unknown[])=>providerCall(...args),
})}));
import { withBudget } from "./metered";
import { complete } from "./model-call";
import { billingScope, recordUsage } from "./billing-context";

beforeEach(()=>{
  spent=0;onRead=undefined;vi.clearAllMocks();
  providerCall.mockResolvedValue({text:"ok",stopReason:"end_turn",usage:{inputTokens:100,outputTokens:0,cachedInputTokens:0,searches:0}});
});

// Mutation: retain a per-scope snapshot instead of refreshing tenant-wide spend.
test("another action consuming the cap stops this action's later requests", async()=>{
  let startA!:()=>void;
  let doneA!:()=>void;
  const permitted = new Promise<void>(r=>{startA=r;});
  const finished = new Promise<void>(r=>{doneA=r;});
  const a = withBudget({action:"a",estimateCents:10,isAdmin:false,fn:async()=>{
    await permitted;
    return complete({system:"test",prompt:"test"});
  }});
  void a.then(doneA);
  const b = withBudget({action:"b",estimateCents:10,isAdmin:false,fn:async()=>{
    startA();await finished;
    return complete({system:"test",prompt:"test"});
  }});
  const [first,second]=await Promise.all([a,b]);
  expect(first.result).toBe("ok");
  expect(second.capped).toContain("daily limit");
  expect(providerCall).toHaveBeenCalledTimes(1);
  expect(spent).toBe(100);
});

// Mutation: publish cost only when an entire action ends, after post-processing.
test("completed response usage blocks other calls before its action finishes", async()=>{
  let responseDone!:()=>void;
  let finishA!:()=>void;
  const response = new Promise<void>(r=>{responseDone=r;});
  const finish = new Promise<void>(r=>{finishA=r;});
  const a=withBudget({action:"a",estimateCents:10,isAdmin:false,fn:async()=>{
    await complete({system:"test",prompt:"test"});responseDone();
    await finish;return "done";
  }});
  await response;
  const b=await withBudget({action:"b",estimateCents:1,isAdmin:false,fn:async()=>complete({system:"test",prompt:"test"})});
  finishA();await a;
  expect(b.capped).toContain("daily limit");
  expect(providerCall).toHaveBeenCalledTimes(1);
  expect(spent).toBe(100);
});

// Mutation: add a newly published own debit back to a counter snapshot read before it.
test("a parallel flush during allowance reads cannot invent extra room", async () => {
  const result = await withBudget({action:"a",estimateCents:10,isAdmin:false,fn:async()=>{
    onRead = async () => {
      recordUsage({inputTokens:100});
      await billingScope()!.flushUsage!();
    };
    return complete({system:"test",prompt:"test"});
  }});
  expect(result.capped).toContain("daily limit");
  expect(providerCall).not.toHaveBeenCalled();
  expect(spent).toBe(100);
});
