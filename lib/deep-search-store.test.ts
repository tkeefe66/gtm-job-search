import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
let db: PGlite;
vi.mock("./metered", () => ({readPaidSearchAvailability: async () => ({})}));
vi.mock("./supabase", () => ({rawQuery: async (sql: string, args: unknown[]) => {
  try { return {data:(await db.query(sql,args)).rows,error:null}; }
  catch(error) { return {data:[],error:{message:(error as Error).message}}; }
}}));
import { readCompanySearchEvidence } from "./deep-search-store";

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create table watchlist(tenant_id text,company text,model_retry_after timestamptz);
    create table crawl_runs(id text,tenant_id text,company text,method text,status text,started_at timestamptz,finished_at timestamptz,roles_found int default 0,new_roles int default 0,error text);
    create table ai_usage_requests(tenant_id text,company text,crawl_run_id text,kind text,state text,cost_microusd bigint);`);
});
beforeEach(async () => {
  await db.exec("truncate watchlist,crawl_runs,ai_usage_requests");
  await db.query("insert into watchlist values ('a','Example',null),('b','Example',null)");
});
afterAll(async () => {await db.close();});
async function run(id:string,status="partial",tenant="a",method:string|null="search",finished=true) {
  await db.query(`insert into crawl_runs(id,tenant_id,company,method,status,started_at,finished_at,new_roles)
    values($1,$2,'Example',$3,$4,now(),case when $5 then now()+interval '2 minutes' else null end,2)`,[id,tenant,method,status,finished]);
}
async function request(runId:string,state:string,cost:number|null,kind="search",tenant="a") {
  await db.query("insert into ai_usage_requests values($1,'Example',$2,$3,$4,$5)",[tenant,runId,kind,state,cost]);
}

// Mutation: treat 'search' method on a skipped direct-only run as a paid search; fabricate zero cost for old history.
test("skipped direct checks are excluded while legacy search costs remain unrecorded", async () => {
  await run("skipped","skipped"); await run("legacy");
  const result=await readCompanySearchEvidence("a");
  expect(result.error).toBeUndefined();
  expect(result.evidence[0].attempts).toHaveLength(1);
  expect(result.evidence[0].attempts[0]).toMatchObject({id:"legacy",costMicrousd:null,costComplete:false,costStatus:"unrecorded"});
});

// Mutation: leak a same-named employer's other-tenant cost or omit grading from the attempt total.
test("request-linked costs include processing and stay within the requested tenant", async () => {
  await run("paid"); await run("other","ok","b");
  await request("paid","known",4000); await request("paid","known",2500,"complete");
  await request("paid","known",999999,"search","b");
  const result=await readCompanySearchEvidence("a","Example");
  expect(result.evidence).toHaveLength(1);
  expect(result.evidence[0].attempts).toHaveLength(1);
  expect(result.evidence[0].attempts[0]).toMatchObject({id:"paid",costMicrousd:6500,costComplete:true,costStatus:"complete"});
  expect((await readCompanySearchEvidence("a","Not on watchlist")).evidence).toEqual([]);
});

// Mutation: round a timeout to free or present a partial measured amount as the total.
test("unknown provider usage remains unknown even when part of the cost is known", async () => {
  await run("failed","error"); await request("failed","unknown",null);
  let result=await readCompanySearchEvidence("a");
  expect(result.evidence[0].attempts[0]).toMatchObject({costMicrousd:null,costComplete:false,costStatus:"unknown"});
  await request("failed","known",5000,"complete");
  result=await readCompanySearchEvidence("a");
  expect(result.evidence[0].attempts[0]).toMatchObject({costMicrousd:5000,costComplete:false,costStatus:"unknown"});
});

test("a request establishes active search history before the crawl has saved its method", async () => {
  await run("active","running","a",null,false); await request("active","in_flight",null);
  const result=await readCompanySearchEvidence("a");
  expect(result.evidence[0].attempts[0]).toMatchObject({id:"active",status:"running",finishedAt:null,costStatus:"running"});
});
