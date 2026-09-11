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
import { withBudget } from "@/lib/metered";
beforeEach(()=>{vi.clearAllMocks();h.authorized=true;
  vi.mocked(withBudget).mockImplementation(async()=>({capped:"Spending limit"}));
  vi.mocked(recoverMissingGrade).mockImplementation(async()=>h.tenant==="capped"
    ? {graded:0,attempted:0,error:"Spending limit"} : {graded:1,attempted:1});
});

// Mutation: return crawled:false immediately after the first capped tenant.
test("skips the capped first candidate and crawls the funded tenant in its own scope", async()=>{
  vi.mocked(recoverMissingGrade).mockResolvedValue({graded:0,attempted:0});
  const checked:string[]=[];
  vi.mocked(withBudget).mockImplementation(async(opts)=>{
    checked.push(h.tenant);
    return h.tenant==="capped" ? {capped:"Spending limit"} : {result:await opts.fn()};
  });
  const response=await GET(new Request("http://localhost/api/cron/crawl-next"));
  expect(await response.json()).toMatchObject({crawled:true,tenantsWithWork:2,tenantsCapped:1});
  expect(checked).toEqual(["capped","healthy"]);
  expect(crawlCompany).toHaveBeenCalledTimes(1);
  expect(h.tenant).toBe("healthy");
});

// Mutation: retry the same capped candidate, or stop before checking all candidates.
test("all capped tenants terminate after one budget attempt each", async()=>{
  vi.mocked(recoverMissingGrade).mockResolvedValue({graded:0,attempted:0});
  const checked:string[]=[];
  vi.mocked(withBudget).mockImplementation(async()=>{
    checked.push(h.tenant);
    if (checked.length>2) throw new Error("Retried an exhausted candidate");
    return {capped:"Spending limit"};
  });
  const response=await GET(new Request("http://localhost/api/cron/crawl-next"));
  expect(await response.json()).toMatchObject({crawled:false,capped:true,tenantsWithWork:2,tenantsCapped:2});
  expect(checked).toEqual(["capped","healthy"]);
  expect(crawlCompany).not.toHaveBeenCalled();
});

// Mutation: treat an empty budget error as a successful crawl or another cap.
test("a budget read error after a skipped tenant remains a failure", async()=>{
  vi.mocked(recoverMissingGrade).mockResolvedValue({graded:0,attempted:0});
  vi.mocked(withBudget).mockImplementation(async()=>h.tenant==="capped"
    ? {capped:"Spending limit"} : {error:""});
  const response=await GET(new Request("http://localhost/api/cron/crawl-next"));
  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({crawled:false,error:"",tenantsWithWork:2,tenantsCapped:1});
  expect(crawlCompany).not.toHaveBeenCalled();
});

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
