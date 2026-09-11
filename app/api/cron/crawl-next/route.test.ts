import { beforeEach, expect, test, vi } from "vitest";
const h = vi.hoisted(() => ({tenant:"",authorized:true}));
vi.mock("next/server", () => ({NextResponse: class extends Response {
  static json(value:unknown, init?:ResponseInit) { return new Response(JSON.stringify(value),init); }
}}));
vi.mock("@/lib/cron-auth", () => ({cronAuthorized:()=>h.authorized}));
vi.mock("@/lib/platform-context", () => ({
  runAsPlatform: (fn:()=>Promise<unknown>)=>fn(),
  runAsTenant: async (tenant:string,fn:()=>Promise<unknown>)=> {h.tenant=tenant;return fn();},
}));
vi.mock("@/app/actions/admin", () => ({listCrawlableTenants:async()=>({tenants:[
  {id:"capped",isAdmin:false},{id:"healthy",isAdmin:false}
]})}));
vi.mock("@/app/actions/watchlist", () => ({getCrawlCandidate:async()=>({company:"Due company",crawlsToday:0,lastCheckedAt:null})}));
vi.mock("@/lib/crawler", () => ({crawlCompany:vi.fn(),loadRunContext:async()=>({})}));
vi.mock("@/lib/metered", () => ({withBudget:vi.fn(async()=>({capped:"Spending limit"}))}));
vi.mock("@/lib/grading-worker", () => ({recoverMissingGrade:vi.fn(async()=>h.tenant==="capped"
  ? {graded:0,attempted:0,error:"Spending limit"} : {graded:1,attempted:1})}));
import { GET } from "./route";
import { recoverMissingGrade } from "@/lib/grading-worker";
import { crawlCompany } from "@/lib/crawler";
beforeEach(()=>{vi.clearAllMocks();h.authorized=true;});

// Mutation: place recovery only inside the no-crawl-candidate branch.
test("a capped due crawl cannot starve another tenant's missing grades", async()=>{
  const response=await GET(new Request("http://localhost/api/cron/crawl-next"));
  expect(await response.json()).toMatchObject({crawled:true,kind:"grading-recovery",recovery:{graded:1}});
  expect(recoverMissingGrade).toHaveBeenCalledTimes(2);
  expect(crawlCompany).not.toHaveBeenCalled();
});
test("dry cron calls never run grading recovery", async()=>{
  await GET(new Request("http://localhost/api/cron/crawl-next?dry=1"));
  expect(recoverMissingGrade).not.toHaveBeenCalled();
});
test("unauthenticated cron calls never enter recovery", async()=>{
  h.authorized=false;
  expect((await GET(new Request("http://localhost/api/cron/crawl-next"))).status).toBe(401);
  expect(recoverMissingGrade).not.toHaveBeenCalled();
});
