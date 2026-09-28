import {beforeEach,expect,test,vi} from "vitest";
const state=vi.hoisted(()=>({tracked:{company:"Example",careers_url:"https://example.test/careers",tracking_enabled:true,ignore_location_rule:false,allow_paid_search:false},
  writes:[] as {table:string;patch:Record<string,unknown>;filters:Record<string,unknown>}[],scope:{searches:0}}));
vi.mock("./tenant",()=>({resolveTenantId:async()=>"tenant"}));
vi.mock("./supabase",()=>({rawQuery:vi.fn(async()=>({data:[],error:null})),supabase:{forTenant:()=>({from:(table:string)=>{
  let patch:Record<string,unknown>|undefined; const filters:Record<string,unknown>={};
  const chain:any={select:()=>chain,insert:(value:Record<string,unknown>)=>{state.writes.push({table,patch:value,filters});return chain;},
    update:(value:Record<string,unknown>)=>{patch=value;return chain;},eq:(key:string,value:unknown)=>{filters[key]=value;return chain;},
    maybeSingle:async()=>({data:state.tracked,error:null}),single:async()=>({data:{id:"run"},error:null}),
    then:(resolve:(value:unknown)=>void)=>{if(patch)state.writes.push({table,patch,filters});resolve({data:[],error:null});}};return chain;
}})}}));
vi.mock("./employer-board-source",()=>({verifiedCompanyBoard:vi.fn(async()=>null)}));
vi.mock("./crawl-snapshot-store",()=>({readCrawlSnapshot:vi.fn(async()=>null),saveCrawlSnapshot:vi.fn(async()=>{}),settledCrawlRoles:vi.fn(async(_t:string,_c:string,roles:unknown[])=>roles)}));
vi.mock("./ingest-roles",async()=>{
  const {MAX_INGEST_READS}=await vi.importActual<typeof import("./ingest-roles")>("./ingest-roles");
  return {MAX_INGEST_READS,ingestRoles:vi.fn(async({roles}:any)=>({added:roles,skipped:[],seenTitles:roles.map((r:any)=>r.role_title)})),refreshChangedCrawlRole:vi.fn(async()=>true)};
});
vi.mock("./fetch-page",()=>({fetchAllowed:vi.fn(async()=>true),fetchPage:vi.fn()}));
vi.mock("./model-call",async()=>{
  const actual=await vi.importActual<typeof import("./model-call")>("./model-call");
  return {...actual,callStructured:vi.fn(),callWithWebSearchDetailed:vi.fn()};
});
vi.mock("./billing-context",()=>({billingScope:()=>state.scope}));
vi.mock("./crawl-policy",async()=>{
  const actual=await vi.importActual<typeof import("./crawl-policy")>("./crawl-policy");return {...actual,crawlPolicyOutcome:vi.fn(async()=>({}))};
});
vi.mock("@/app/actions/jobs",()=>({getJobStatuses:vi.fn(async()=>({statuses:[]}))}));
vi.mock("./settings-store",()=>({readCriteriaChangedAt:async()=>null}));
import {crawlCompany,type RunContext} from "./crawler";
import {verifiedCompanyBoard} from "./employer-board-source";
import {fetchPage} from "./fetch-page";
import {callStructured,callWithWebSearchDetailed,SpendLimitReachedError} from "./model-call";
import {readCrawlSnapshot,saveCrawlSnapshot,settledCrawlRoles} from "./crawl-snapshot-store";
import {ingestRoles,refreshChangedCrawlRole} from "./ingest-roles";
import {crawlPolicyOutcome} from "./crawl-policy";
import {DEFAULT_CRITERIA} from "./search-criteria";
import {DEFAULT_PROFILE} from "./profile";
import {rawQuery} from "./supabase";
import type {CrawlSnapshot} from "./crawl-snapshot";
import {MAX_PAGE_CHARS} from "./page-extract";
import {withAIAttribution,aiAttribution} from "./ai-attribution";
import {getJobStatuses} from "@/app/actions/jobs";

const role={role_title:"Systems Lead",job_url:"https://example.test/jobs/1",location:"Remote",salary_range:"$200000",description_summary:"Build systems",seniority:"Lead",fit_signal:"",ic_flag:false};
const ctx:RunContext={criteria:{...DEFAULT_CRITERIA,titles:["Systems Lead"]},profile:DEFAULT_PROFILE,fitInputs:{fitBrain:"Systems leadership"} as RunContext["fitInputs"],criteriaChangedAt:null};
const html=`<p>${"We are hiring systems people. ".repeat(30)}</p><a href="/jobs/1">Systems Lead</a><a href="/jobs/2">Engineer</a><a href="/jobs/3">Designer</a>`;
let snapshots:CrawlSnapshot[]=[];
beforeEach(()=>{
  vi.clearAllMocks();state.writes=[];state.scope.searches=0;
  state.tracked={company:"Example",careers_url:"https://example.test/careers",tracking_enabled:true,ignore_location_rule:false,allow_paid_search:false};
  vi.mocked(verifiedCompanyBoard).mockResolvedValue(null);
  vi.mocked(fetchPage).mockResolvedValue(html);
  vi.mocked(callStructured).mockResolvedValue(JSON.stringify([role]));
  vi.mocked(refreshChangedCrawlRole).mockResolvedValue(true);
  vi.mocked(ingestRoles).mockImplementation(async({roles})=>({added:roles,skipped:[],seenTitles:roles.map(r=>r.role_title)}));
  vi.mocked(settledCrawlRoles).mockImplementation(async(_t,_c,roles)=>roles);
  snapshots=[];
  vi.mocked(readCrawlSnapshot).mockImplementation(async(_t,_c,source,criteria)=>{
    const snapshot=snapshots.slice().reverse().find(item=>(!source||item.sourceKey===source)&&(!criteria||item.criteriaHash===criteria));
    return snapshot?structuredClone(snapshot):null;
  });
  vi.mocked(rawQuery).mockResolvedValue({data:[],error:null});
  vi.mocked(saveCrawlSnapshot).mockImplementation(async(_t,_c,snapshot)=>{snapshots.push(structuredClone(snapshot));});
});

test("a large careers page remains readable without enabling paid search or expanding the AI prompt",async()=>{
  // Mutation: increase board discovery's allowance but forget the crawler's ordinary HTML reader.
  const largeHtml=`<script>${"x".repeat(5*1024*1024)}</script>${html}`;
  vi.mocked(fetchPage).mockImplementation(async(_url,options)=>
    Buffer.byteLength(largeHtml)>(options?.maxBytes??2*1024*1024)?null:largeHtml);
  expect(await crawlCompany("Example",{ctx,trigger:"check"})).toMatchObject({status:"ok",rolesFound:1,newRoles:1});
  expect(callWithWebSearchDetailed).not.toHaveBeenCalled();
  expect(vi.mocked(callStructured).mock.calls[0][0].prompt.length).toBeLessThan(10000);
});

test("a link-heavy careers page keeps AI input bounded and cannot close roles or cache a complete result",async()=>{
  // Mutation: cap visible text but forward millions of link characters, or treat omitted links as a complete inventory.
  const links=Array.from({length:10000},(_,i)=>`<a href="/jobs/${i}?details=${"x".repeat(500)}">Systems Lead ${i}</a>`).join("");
  vi.mocked(fetchPage).mockResolvedValue(`${html}${links}`);
  expect((await crawlCompany("Example",{ctx,trigger:"check"})).status).toBe("partial");
  expect(vi.mocked(callStructured).mock.calls[0][0].prompt.length).toBeLessThan(65000);
  expect(saveCrawlSnapshot).not.toHaveBeenCalled();
  expect(state.writes.filter(w=>w.table==="crawl_runs"&&w.patch.finished_at).every(w=>w.patch.closure_eligible===false)).toBe(true);
});

test("link truncation prevents closure even when visible page text fits",async()=>{
  // Mutation: detect text truncation but ignore link-list truncation when marking extraction complete.
  vi.mocked(fetchPage).mockResolvedValue(`${html}<a href="/jobs/large?details=${"x".repeat(25000)}">Systems Lead</a>`);
  expect((await crawlCompany("Example",{ctx,trigger:"check"})).status).toBe("partial");
  expect(vi.mocked(callStructured).mock.calls[0][0].prompt).not.toContain("x".repeat(25000));
  expect(saveCrawlSnapshot).not.toHaveBeenCalled();
  expect(state.writes.find(w=>w.table==="crawl_runs"&&w.patch.finished_at)?.patch.closure_eligible).toBe(false);
});

test.each([7,20])("a complete board with %i matching roles finishes in one check",async count=>{
  // Mutation: retain the six-role processing cap, leaving a readable board needlessly partial.
  const roles=Array.from({length:count},(_,i)=>({...role,role_title:`Systems Lead ${i}`,job_url:`https://example.test/jobs/${i}`}));
  vi.mocked(verifiedCompanyBoard).mockResolvedValue({resolution:{vendor:"ashby",slug:"example",source:"read"},
    postings:roles.map(r=>({title:r.role_title,url:r.job_url,body:"Build systems"}))});
  expect(await crawlCompany("Example",{ctx,trigger:"check"})).toMatchObject({status:"ok",rolesFound:count,newRoles:count});
  expect(Object.keys(snapshots.at(-1)!.processed)).toHaveLength(count);
  expect(callWithWebSearchDetailed).not.toHaveBeenCalled();
  expect((await crawlCompany("Example",{ctx,trigger:"check"})).status).toBe("unchanged");
  expect(ingestRoles).toHaveBeenCalledTimes(1);
});

test("a board with more than twenty matching roles keeps the remainder for the next check",async()=>{
  // Mutation: remove the per-check cap or acknowledge unprocessed overflow as complete.
  const roles=Array.from({length:21},(_,i)=>({...role,role_title:`Systems Lead ${i}`,job_url:`https://example.test/jobs/${i}`}));
  vi.mocked(callStructured).mockResolvedValue(JSON.stringify(roles));
  expect((await crawlCompany("Example",{ctx,trigger:"check"})).status).toBe("partial");
  expect(Object.keys(snapshots.at(-1)!.processed)).toHaveLength(20);
  expect((await crawlCompany("Example",{ctx,trigger:"check"})).status).toBe("ok");
  expect(Object.keys(snapshots.at(-1)!.processed)).toHaveLength(21);
  expect(ingestRoles).toHaveBeenCalledTimes(1);
  expect(refreshChangedCrawlRole).toHaveBeenCalledTimes(1);
});

test("twenty unsuccessful listings cannot starve a later valid listing",async()=>{
  // Mutation: repeatedly select the first twenty pending entries instead of rotating failed attempts.
  const roles=Array.from({length:21},(_,i)=>({...role,role_title:`Systems Lead ${i}`,job_url:`https://example.test/jobs/${i}`}));
  vi.mocked(callStructured).mockResolvedValue(JSON.stringify(roles));
  vi.mocked(ingestRoles).mockResolvedValue({added:[],skipped:[],seenTitles:[]});
  vi.mocked(settledCrawlRoles).mockResolvedValue([]);
  vi.mocked(refreshChangedCrawlRole).mockResolvedValue(false);
  await crawlCompany("Example",{ctx});
  await crawlCompany("Example",{ctx});
  expect(vi.mocked(ingestRoles).mock.calls[0][0].roles).toHaveLength(20);
  expect(vi.mocked(ingestRoles).mock.calls[1][0].roles[0].job_url).toBe("https://example.test/jobs/20");
});

test("a truncated direct page remains partial and cannot populate or reuse complete extraction cache",async()=>{
  // Mutation: cache a valid JSON response even though its source input was truncated.
  vi.mocked(fetchPage).mockResolvedValue(`<p>${"Words ".repeat(MAX_PAGE_CHARS)}</p>${html}`);
  expect((await crawlCompany("Example",{ctx})).status).toBe("partial");
  expect((await crawlCompany("Example",{ctx})).status).toBe("partial");
  expect(callStructured).toHaveBeenCalledTimes(2);
  expect(saveCrawlSnapshot).not.toHaveBeenCalled();
  expect(state.writes.filter(w=>w.table==="crawl_runs"&&w.patch.finished_at).every(w=>w.patch.closure_eligible===false)).toBe(true);
});

test("company attribution preserves an on-track parent trigger",async()=>{
  // Mutation: label every automatic company request scheduled, losing on-track attribution.
  vi.mocked(callStructured).mockImplementation(async()=>{expect(aiAttribution().trigger).toBe("on-track");return JSON.stringify([role]);});
  await withAIAttribution({trigger:"on-track"},()=>crawlCompany("Example",{ctx,trigger:"automatic"}));
  expect(callStructured).toHaveBeenCalledTimes(1);
});

test("changed effective criteria invalidate extraction and refresh previously known active listings",async()=>{
  // Mutation: key extraction only by source content, or acknowledge an old grade under new criteria.
  await crawlCompany("Example",{ctx});
  await crawlCompany("Example",{ctx:{...ctx,criteria:{...ctx.criteria,locationRule:"Anywhere"}}});
  expect(callStructured).toHaveBeenCalledTimes(2);
  expect(refreshChangedCrawlRole).toHaveBeenCalledTimes(1);
  expect(snapshots[0].criteriaHash).not.toBe(snapshots.at(-1)?.criteriaHash);
});

test("a failed changed-listing refresh remains pending despite its old stored grade",async()=>{
  // Mutation: mark observed data processed or borrow the previously stored score after a failed refresh.
  await crawlCompany("Example",{ctx});
  vi.mocked(fetchPage).mockResolvedValue(html.replace("Systems Lead</a>","Updated Systems Lead</a>"));
  vi.mocked(callStructured).mockResolvedValue(JSON.stringify([{...role,salary_range:"$250000"}]));
  vi.mocked(refreshChangedCrawlRole).mockResolvedValue(false);
  vi.mocked(ingestRoles).mockResolvedValue({added:[],skipped:[role],seenTitles:["systems lead"]});
  expect((await crawlCompany("Example",{ctx})).status).toBe("partial");
  expect((await crawlCompany("Example",{ctx})).status).toBe("partial");
  expect(refreshChangedCrawlRole).toHaveBeenCalledTimes(2);
});

test("unchanged normalized direct page is fetched again without repeated model extraction or ingestion",async()=>{
  // Mutation: charge another extraction for whitespace changes, or ingest unchanged listings.
  expect((await crawlCompany("Example",{ctx})).status).toBe("ok");
  vi.mocked(fetchPage).mockResolvedValue(html.replace(/ /g,"  "));
  expect((await crawlCompany("Example",{ctx})).status).toBe("unchanged");
  expect(callStructured).toHaveBeenCalledTimes(1);
  expect(ingestRoles).toHaveBeenCalledTimes(1);
  expect(fetchPage).toHaveBeenCalledTimes(2);
  expect(state.writes.filter(w=>w.table==="crawl_runs"&&w.patch.finished_at).at(-1)?.patch)
    .toMatchObject({closure_eligible:true,role_titles:["systems lead"]});
});

test("verified direct board works before paying for a missing careers URL and dry-run writes nothing",async()=>{
  // Mutation: resolve careers URL before trying a known board, or warm dry-run caches.
  state.tracked.careers_url=null as unknown as string;
  vi.mocked(verifiedCompanyBoard).mockResolvedValue({resolution:{vendor:"ashby",slug:"example",source:"read"},postings:[{title:role.role_title,url:role.job_url,body:"Build systems"}]});
  await crawlCompany("Example",{ctx,dryRun:true});
  expect(callWithWebSearchDetailed).not.toHaveBeenCalled();
  expect(saveCrawlSnapshot).not.toHaveBeenCalled();
  expect(crawlPolicyOutcome).not.toHaveBeenCalled();
  expect(state.writes).toEqual([]);
});

test("Deep search shares a five-search cap between discovery and fallback and never provides closure",async()=>{
  // Mutation: give both provider calls their own five-search allowance.
  state.tracked.careers_url=null as unknown as string;
  vi.mocked(fetchPage).mockResolvedValue("<div>Shell</div>");
  vi.mocked(callWithWebSearchDetailed).mockImplementation(async(opts)=>{
    if(opts.maxTokens===4000){state.scope.searches+=2;return {text:JSON.stringify({careers_url:"https://example.test/careers"}),stopReason:"end_turn"};}
    state.scope.searches+=3;return {text:JSON.stringify([role]),stopReason:"end_turn"};
  });
  expect((await crawlCompany("Example",{ctx,trigger:"deep"})).status).toBe("partial");
  expect(vi.mocked(callWithWebSearchDetailed).mock.calls.map(([o])=>o.maxSearches)).toEqual([2,3]);
  expect(state.writes.find(w=>w.table==="crawl_runs"&&w.patch.finished_at)?.patch.closure_eligible).toBe(false);
});

test("budget refusal cannot become an empty listing or model failure",async()=>{
  // Mutation: convert paid-budget refusal into empty closure evidence or model backoff.
  vi.mocked(callStructured).mockRejectedValue(new SpendLimitReachedError("Paused"));
  expect((await crawlCompany("Example",{ctx})).status).toBe("skipped");
  expect(crawlPolicyOutcome).toHaveBeenCalledWith("tenant","Example",expect.objectContaining({modelAttempt:"none",status:"skipped"}));
  expect(state.writes.find(w=>w.table==="crawl_runs"&&w.patch.finished_at)?.patch.closure_eligible).toBe(false);
});

test("a material change refreshes its old listing and retains every observed title",async()=>{
  // Mutation: persist only changed titles, causing unchanged live listings to look absent.
  const other={...role,role_title:"Systems Architect",job_url:"https://example.test/jobs/2"};
  vi.mocked(callStructured).mockResolvedValue(JSON.stringify([role,other]));
  await crawlCompany("Example",{ctx});
  vi.mocked(fetchPage).mockResolvedValue(html.replace("Systems Lead</a>","Systems Lead — updated compensation</a>"));
  vi.mocked(callStructured).mockResolvedValue(JSON.stringify([{...role,salary_range:"$250000"},other]));
  await crawlCompany("Example",{ctx});
  expect(refreshChangedCrawlRole).toHaveBeenCalledWith(expect.objectContaining({role:expect.objectContaining({salary_range:"$250000"})}));
  expect(refreshChangedCrawlRole).toHaveBeenCalledTimes(1);
  expect(state.writes.filter(w=>w.table==="crawl_runs"&&w.patch.finished_at).at(-1)?.patch.role_titles).toEqual(["systems lead","systems architect"]);
});

test("closure updates recheck mutable ownership and user status after selecting a stale role",async()=>{
  // Mutation: update a selected job by ID alone after a user moved it during the check.
  vi.mocked(rawQuery).mockImplementation(async(sql:string)=>({data:sql.includes("from crawl_runs")?
    [{role_titles:["systems lead"],finished_at:new Date().toISOString()}]:sql.includes("select id, role_title from jobs")?
    [{id:"stale",role_title:"Old Role"}]:[],error:null}) as never);
  vi.mocked(getJobStatuses).mockResolvedValue({statuses:[{key:"Not Interested",label:"Not Interested",bucket:"terminal",hidden:false}] as never});
  await crawlCompany("Example",{ctx});
  expect(state.writes.find(write=>write.table==="jobs")?.filters).toEqual({id:"stale",status:"New",source:"Crawl",grading_chosen:false});
});
