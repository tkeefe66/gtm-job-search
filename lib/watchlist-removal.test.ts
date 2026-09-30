import {beforeAll, afterAll, beforeEach, expect, test, vi} from "vitest";
import {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";
import {deepSearchAdvice} from "./deep-search-advice";
let db: PGlite;
vi.mock("./supabase", () => ({rawQuery: async(sql:string,args:unknown[]) => {
  try {return {data:(await db.query(sql,args)).rows,error:null};}
  catch(error) {return {data:[],error:{message:(error as Error).message}};}
}}));
vi.mock("./metered",()=>({readPaidSearchAvailability:async()=>({})}));
import {readSuppressedCompanyKeys} from "./watchlist-removal-store";
import {readCompanySearchEvidence} from "./deep-search-store";
import {crawlPolicyOutcome} from "./crawl-policy";
beforeAll(async()=>{
  db = new PGlite();
  await db.exec(`create table watchlist(tenant_id text, company text, careers_url text, tracking_enabled boolean default true,
    crawl_method text, last_crawl_status text, last_crawl_error text, consecutive_failures int default 0, failing_since timestamptz,
    consecutive_model_failures int default 0, model_retry_after timestamptz, last_checked_at timestamptz, last_attempted_at timestamptz,
    last_successful_check_at timestamptz, next_attempt_at timestamptz,crawl_interval_days int default 7);
    create table crawl_runs(id text,tenant_id text,company text,method text,status text,started_at timestamptz,finished_at timestamptz,roles_found int default 0,new_roles int default 0,error text);
    create table ai_usage_requests(tenant_id text,company text,crawl_run_id text,kind text,state text,cost_microusd bigint);`);
  await db.exec(readFileSync("db/migrations/029_watchlist_removal.sql","utf8"));
});
beforeEach(async()=>{await db.exec("truncate watchlist,crawl_runs,ai_usage_requests");});
afterAll(async()=>{await db.close();});

// Mutation: suppress all paused employers or leak another tenant's exclusion.
test("only this tenant's not-interested companies are suppressed",async()=>{
  await db.exec(`insert into watchlist(tenant_id,company,tracking_enabled,removal_reason) values
    ('a','No Thanks',false,'not_interested'),('a','Broken Page',false,'source_problem'),
    ('a','Restored',true,'not_interested'),('a','Legacy',false,null),('b','Foreign',false,'not_interested');`);
  const result=await readSuppressedCompanyKeys("a");
  expect(result.error).toBeUndefined();expect(Array.from(result.keys)).toEqual(["no thanks"]);
});

// Mutation: changing URL revives a removed company, loses history, or applies old failure to the new page.
test("source changes reset assessment but preserve removal and old paid-search evidence",async()=>{
  await db.exec(`insert into watchlist(tenant_id,company,careers_url,tracking_enabled,removal_reason,removed_at,crawl_method,last_crawl_status,last_crawl_error,consecutive_model_failures,model_retry_after,next_attempt_at)
    values('a','Example','https://old.example/jobs',false,'not_interested',now(),'search','error','Old failure',3,now()+interval '14 days',now()+interval '7 days');
    insert into crawl_runs(id,tenant_id,company,method,status,started_at,finished_at,error,source_url) values('old','a','Example','search','error',now()-interval '1 hour',now()-interval '50 minutes','Old failure','https://old.example/jobs');
    insert into ai_usage_requests values('a','Example','old','search','known',4500);
    update watchlist set careers_url='https://new.example/careers' where tenant_id='a';`);
  const row=(await db.query("select * from watchlist")).rows[0];
  expect(row).toMatchObject({tracking_enabled:false,removal_reason:"not_interested",source_revision:1,crawl_method:null,last_crawl_status:null,model_retry_after:null,next_attempt_at:null});
  expect(row.removed_at).not.toBeNull();
  let evidence=(await readCompanySearchEvidence("a")).evidence[0];
  expect(evidence.latestCheck).toBeNull();
  expect(evidence.attempts[0]).toMatchObject({sourceUrl:"https://old.example/jobs",previousSource:true,costMicrousd:4500});
  expect(deepSearchAdvice(evidence,{})).toMatchObject({state:"direct",blocked:true});
  await db.exec(`insert into crawl_runs(id,tenant_id,company,method,status,started_at,finished_at,source_revision,source_url)
    values('new','a','Example','fetch','partial',now(),now(),1,'https://new.example/careers');`);
  evidence=(await readCompanySearchEvidence("a")).evidence[0];
  expect(deepSearchAdvice(evidence,{})).toMatchObject({state:"untested",blocked:false,requiresAcknowledgement:false});
  // A finish from the old source must not put the replacement back into cooldown.
  await crawlPolicyOutcome("a","Example",{trigger:"deep",status:"error",modelAttempt:"failure",sourceRevision:0});
  expect((await db.query("select consecutive_model_failures,last_attempted_at from watchlist")).rows[0]).toMatchObject({consecutive_model_failures:0,last_attempted_at:null});
});

// Mutation: saving the identical URL forgets current-source failures and resets spend safeguards.
test("saving the same URL leaves its assessment intact",async()=>{
  await db.exec(`insert into watchlist(tenant_id,company,careers_url,last_crawl_status,consecutive_model_failures)
    values('a','Example','https://same.example/jobs','error',2);
    update watchlist set careers_url='https://same.example/jobs';`);
  expect((await db.query("select source_revision,last_crawl_status,consecutive_model_failures from watchlist")).rows[0]).toEqual({source_revision:0,last_crawl_status:"error",consecutive_model_failures:2});
});
