import { beforeEach,expect,test,vi } from "vitest";
const state=vi.hoisted(()=>({backgroundLimit:100,events:[] as unknown[],reserved:0,known:0,unknown:0}));
const providerCall=vi.hoisted(()=>vi.fn());
vi.mock("./tenant",()=>({resolveTenantId:async()=>"tenant-a"}));
vi.mock("./secret-box",()=>({open:()=>"test-key"}));
vi.mock("./supabase",()=>({rawQuery:async()=>({data:[{provider:"anthropic",model:"claude-sonnet-4-6"}],error:null})}));
vi.mock("./spend-limit-store",()=>({readSpendLimits:async()=>({limits:{dailyCents:2000,monthlyCents:10000}}),
  readBackgroundSpendLimits:async()=>({limits:{dailyCents:state.backgroundLimit,monthlyCents:1000},usesDefaults:true})}));
vi.mock("./usage-store",()=>({
  readSpent:async()=>({spentCents:state.reserved}),
  reserveSpend:async(o:{estimateCents:number;backgroundLimits?:{dailyCents:number|null}})=>{
    if(o.backgroundLimits?.dailyCents===0)return{ok:false,spentCents:0,reason:"daily",scope:"background"};
    state.reserved+=o.estimateCents;return{ok:true,spentCents:o.estimateCents,availableCents:100};
  },advanceSpend:async()=>({}),reconcileSpend:async(e:unknown)=>{state.events.push(e);return{};},
}));
vi.mock("./ai-ledger",()=>({
  recoverStaleAIOperations:async()=>({recovered:0}),beginAIRequest:async()=>"request",
  finishAIRequest:async()=>{state.known++;},markAIRequestUnknown:async()=>{state.unknown++;},
  exactCompletionCost:()=>1000,
}));
vi.mock("./providers/registry",()=>({providerFor:()=>({id:"anthropic",defaultModel:"claude-sonnet-4-6",pricedModels:["claude-sonnet-4-6"],
  searchCapEnforcement:"in-request",costCents:()=>1,complete:(...args:unknown[])=>providerCall(...args)})}));
import { withBudget } from "./metered";
import { complete } from "./model-call";
import { billingScope } from "./billing-context";
const response={text:"ok",stopReason:"end_turn",usage:{inputTokens:1,outputTokens:0,cachedInputTokens:0,searches:0}};
beforeEach(()=>{state.backgroundLimit=100;state.events=[];state.reserved=0;state.known=0;state.unknown=0;vi.clearAllMocks();providerCall.mockResolvedValue(response);});

// Mutation: exhausted background allowance prevents free checks or allows provider dispatch.
test("free collection runs at a zero background limit while every model dispatch refuses",async()=>{
  state.backgroundLimit=0;
  const free=vi.fn();
  const result=await withBudget({action:"crawl",estimateCents:10,isAdmin:false,workload:"background",allowFreeWork:true,fn:async()=>{
    free();expect(billingScope()).not.toBeNull();return complete({system:"s",prompt:"p"});
  }});
  expect(free).toHaveBeenCalledOnce();expect(providerCall).not.toHaveBeenCalled();expect(result.capped).toContain("background allowance");
});

// Mutation: release final reservation as zero after a provider timeout.
test("a provider exception reaches settlement as unknown usage",async()=>{
  providerCall.mockRejectedValue(new Error("timeout"));
  await expect(withBudget({action:"crawl",estimateCents:10,isAdmin:false,fn:()=>complete({system:"s",prompt:"p"})})).rejects.toThrow("timeout");
  expect(state.unknown).toBe(1);expect(state.events[0]).toMatchObject({costComplete:false,estimateCents:10});
});

// Mutation: finally reconciles after Promise.all's first failure while a sibling request is still running.
test("settlement waits for the in-flight sibling and includes its completed usage",async()=>{
  let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
  let bothStarted!:()=>void;const started=new Promise<void>(r=>{bothStarted=r;});
  providerCall.mockImplementationOnce(async()=>{await started;throw new Error("first failed");});
  providerCall.mockImplementationOnce(async()=>{bothStarted();await gate;return response;});
  const run=withBudget({action:"crawl",estimateCents:10,isAdmin:false,fn:()=>Promise.all([complete({system:"s",prompt:"a"}),complete({system:"s",prompt:"b"})])});
  const rejected=expect(run).rejects.toThrow("first failed");
  await started;await new Promise(r=>setTimeout(r,0));
  expect(state.events).toHaveLength(0);release();await rejected;
  expect(state.known).toBe(1);expect(state.events).toHaveLength(1);
  expect(state.events[0]).toMatchObject({costComplete:false,costMicrousd:1000,inputTokens:1});
});
