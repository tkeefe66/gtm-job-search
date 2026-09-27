import {PGlite} from "@electric-sql/pglite";
import {afterAll,beforeAll,beforeEach,expect,test,vi} from "vitest";
const state=vi.hoisted(()=>({db:null as PGlite|null}));
vi.mock("./tenant",()=>({resolveTenantId:async()=>"tenant"}));
vi.mock("./supabase",()=>({rawQuery:async(sql:string,values:unknown[])=>({data:(await state.db!.query(sql,values)).rows,error:null}),
  tenantTransaction:async(_tenant:string,fn:(query:(sql:string,values?:unknown[])=>Promise<unknown>)=>Promise<unknown>)=>fn((sql,values)=>sql.includes("pg_advisory_xact_lock")?Promise.resolve({rows:[]}):state.db!.query(sql,values)),
  describeThrown:(error:Error)=>({message:error.message})}));
vi.mock("@/app/actions/jobs",()=>({getJobStatuses:vi.fn()}));
vi.mock("@/app/actions/parse-role",()=>({scoreFit:vi.fn(async()=>({score:4,rationale:"Current requirements fit"}))}));
vi.mock("./grading-store",()=>({gradingPaused:async()=>null,recordGradeFailure:vi.fn(),updateMissingGrade:vi.fn()}));
vi.mock("./posting-read",()=>({readPosting:vi.fn(),readPostingText:vi.fn(async()=>({kind:"read",summary:"Updated source requirements",department:"Systems",detail:{requirements:["Build systems"],niceToHaves:[]}})),readDetail:(r:any)=>r.detail}));
import {refreshChangedCrawlRole} from "./ingest-roles";
import {scoreFit} from "@/app/actions/parse-role";
import {patchJobWithActor} from "./job-disposition-store";
import {readPosting,readPostingText} from "./posting-read";
import {acceptJob} from "./job-acceptance";
const options={company:"Example",role:{role_title:"Systems Lead",job_url:"https://example.test/jobs/1",location:"Remote",salary_range:"$250000",description_summary:"",seniority:"Lead",fit_signal:"",ic_flag:false},body:"Updated text",fitInputs:{} as never};
beforeAll(async()=>{
  state.db=new PGlite();
  await state.db.exec(`create table jobs(id text,tenant_id text,company text,role_title text,job_url text,source text,status text,
    grading_chosen boolean,never_live boolean,updated_at timestamptz,created_at timestamptz,company_description text,
    grading_lease text,grading_next_at timestamptz,posting jsonb,key_skills text,department text,location text,salary_range text,
    fit_score int,fit_summary text,grading_state text,grading_error text,notes text,
    crawl_refresh_protected boolean not null default false,source_url text)`);
});
beforeEach(async()=>{
  vi.clearAllMocks();
  vi.mocked(scoreFit).mockResolvedValue({score:4,rationale:"Current requirements fit"});
  await state.db!.exec(`delete from jobs;insert into jobs(id,tenant_id,company,role_title,job_url,source,status,grading_chosen,never_live,
    updated_at,created_at,fit_score,notes,key_skills) values('job','tenant','Example','Systems Lead','https://example.test/jobs/1',
    'Crawl','New',false,false,now(),now(),3,'Keep my note','Old requirements')`);
});
afterAll(async()=>{await state.db?.close();});

test("an unchanged user-owned status and note survive a successful material source refresh",async()=>{
  // Mutation: reset status or notes as part of refreshing source content.
  expect(await refreshChangedCrawlRole(options)).toBe(true);
  const rows=await state.db!.query("select status,notes,fit_score,key_skills,grading_lease from jobs");
  expect(rows.rows[0]).toEqual({status:"New",notes:"Keep my note",fit_score:4,key_skills:"Updated source requirements",grading_lease:null});
});

test("a user moving status while grading runs prevents the late refresh write",async()=>{
  // Mutation: final save checks only ID/lease and overwrites a concurrent user decision.
  vi.mocked(scoreFit).mockImplementation(async()=>{
    // Deliberately do not bump updated_at: status itself must independently guard the save.
    await state.db!.exec("update jobs set status='Applied',notes='Application note'");
    return {score:4,rationale:"Current requirements fit"};
  });
  expect(await refreshChangedCrawlRole(options)).toBe(false);
  expect((await state.db!.query("select status,notes,fit_score,key_skills from jobs")).rows[0])
    .toEqual({status:"Applied",notes:"Application note",fit_score:3,key_skills:"Old requirements"});
});

test("terminal manually chosen and other-tenant rows buy no refresh calls",async()=>{
  // Mutation: refresh every matching URL regardless of ownership, terminal state, or tenant.
  await state.db!.exec("update jobs set status='Rejected'");
  expect(await refreshChangedCrawlRole(options)).toBe(true);
  await state.db!.exec("update jobs set status='New',grading_chosen=true");
  expect(await refreshChangedCrawlRole(options)).toBe(true);
  await state.db!.exec("update jobs set grading_chosen=false,tenant_id='other'");
  expect(await refreshChangedCrawlRole(options)).toBe(false);
  expect(scoreFit).not.toHaveBeenCalled();
});

test("manual compensation department and fit edits survive a later crawl without buying another grade",async()=>{
  // Mutation: treat a previously edited New/Crawl row as untouched merely because its timestamp is stable now.
  await patchJobWithActor("tenant","job",{salary_range:"$300000",department:"Manual department",fit_score:5},"user");
  expect(await refreshChangedCrawlRole(options)).toBe(true);
  expect((await state.db!.query("select salary_range,department,fit_score from jobs")).rows[0])
    .toEqual({salary_range:"$300000",department:"Manual department",fit_score:5});
  expect(readPostingText).not.toHaveBeenCalled();
  expect(scoreFit).not.toHaveBeenCalled();
});

test("the final save respects a protection marker set after the refresh claimed a row",async()=>{
  // Mutation: check manual ownership only before paying, leaving a late save able to overwrite the edit.
  vi.mocked(scoreFit).mockImplementation(async()=>{
    await state.db!.exec("update jobs set crawl_refresh_protected=true,fit_score=5");
    return {score:4,rationale:"Current requirements fit"};
  });
  expect(await refreshChangedCrawlRole(options)).toBe(false);
  expect((await state.db!.query("select fit_score,key_skills from jobs")).rows[0])
    .toEqual({fit_score:5,key_skills:"Old requirements"});
});

test("missing source compensation and location use the same saved values for scoring and persistence",async()=>{
  // Mutation: score blank board metadata while retaining different populated columns in the saved role.
  await state.db!.exec("update jobs set salary_range='$300000',location='Denver'");
  expect(await refreshChangedCrawlRole({...options,role:{...options.role,salary_range:"",location:""}})).toBe(true);
  expect(scoreFit).toHaveBeenCalledWith(expect.objectContaining({salary_range:"$300000",location:"Denver"}));
  expect((await state.db!.query("select salary_range,location from jobs")).rows[0])
    .toEqual({salary_range:"$300000",location:"Denver"});
});

test.each(["https://www.builtin.com/job/systems-lead/123","https://www.indeed.com/q-systems-jobs.html"])(
  "policy-rejected changed source %s settles without reading or scoring it",async(job_url)=>{
    // Mutation: route an observed title around the fresh-ingest admission guards and buy an excluded-source read.
    vi.mocked(readPosting).mockResolvedValue({kind:"unreadable"});
    expect(await refreshChangedCrawlRole({...options,body:undefined,role:{...options.role,job_url}})).toBe(true);
    expect(readPosting).not.toHaveBeenCalled();
    expect(scoreFit).not.toHaveBeenCalled();
  }
);

test("manual insertion protects source fields even if its payload claims to be Crawl and opts out",async()=>{
  // Mutation: trust a submitted source or false marker instead of the authenticated insertion actor.
  const result=await acceptJob("tenant",{company:"Other",role_title:"Systems Lead",source:"Crawl",crawl_refresh_protected:false} as never,"user");
  expect(result.job.crawl_refresh_protected).toBe(true);
});

test("automated insertion uses the database protection default instead of incoming ownership flags",async()=>{
  // Mutation: copy an untrusted true marker into an automatic insertion and silently disable future refresh.
  const result=await acceptJob("tenant",{company:"Other",role_title:"Systems Lead",source:"Crawl",crawl_refresh_protected:true} as never,"automation");
  expect(result.job.crawl_refresh_protected).toBe(false);
});
