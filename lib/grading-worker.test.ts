import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const h = vi.hoisted(() => ({ db: null as unknown as PGlite, capped:false, writeFailure:false }));
vi.mock("@/lib/tenant", () => ({ resolveTenantId: async () => "tenant-a" }));
vi.mock("@/lib/require-actor", () => ({requireActor:async()=>({isAdmin:false})}));
vi.mock("@/lib/supabase", () => ({ rawQuery: vi.fn(async (sql:string, values:unknown[]) => {
  if (h.writeFailure && sql.startsWith("update jobs set fit_score")) return {data:[],error:{message:""}};
  try { return { data:(await h.db.query(sql,values)).rows,error:null }; }
  catch (e) { return {data:[],error:{message:String(e)}}; }
}) }));
vi.mock("@/lib/metered", () => ({ withBudget: vi.fn(async ({fn}:{fn:()=>Promise<unknown>}) =>
  h.capped ? {capped:"Spending limit reached"} : {result:await fn()}) }));
vi.mock("@/lib/search-criteria", () => ({ loadScoringInputs: async () => ({fitBrain:"Candidate criteria"}) }));
vi.mock("@/app/actions/jobs", () => ({ getJobStatuses: async () => ({statuses:[
  {key:"New",bucket:"active",hidden:false}, {key:"Rejected",bucket:"terminal",hidden:false},
]}) }));
vi.mock("@/app/actions/parse-role", () => ({scoreFit:vi.fn()}));

import { recoverMissingGrade } from "./grading-worker";
import { recordGradeFailure } from "./grading-store";
import { scoreFit } from "@/app/actions/parse-role";
import { withBudget } from "./metered";
import { SCORING_INPUT_COLUMNS } from "./rescore-scope";
import { retryMissingGrades } from "@/app/actions/grading";

beforeAll(async () => {
  h.db = new PGlite();
  await h.db.exec(`create table jobs (id text primary key,tenant_id text,status text default 'New',
    fit_score int,never_live boolean default false,posting jsonb,
    ${SCORING_INPUT_COLUMNS.map(c => `${c} text`).join(',')},
    created_at timestamptz default now(),updated_at timestamptz default now(),
    grading_state text default 'pending',grading_attempts int default 0,
    grading_next_at timestamptz,grading_error text,grading_lease uuid,grading_chosen boolean default false);
    create table app_settings(tenant_id text,key text,value jsonb,primary key(tenant_id,key));`);
});
afterAll(() => h.db.close());
beforeEach(async () => {
  vi.clearAllMocks(); h.capped=false; h.writeFailure=false;
  vi.mocked(scoreFit).mockResolvedValue({score:4,rationale:"Strong domain fit"});
  await h.db.exec("delete from jobs; delete from app_settings");
  await h.db.query("insert into jobs(id,tenant_id,company,role_title) values ('role','tenant-a','Example','Director')");
});

// Mutation: omit persisted fit_score or rationale, or skip the withBudget boundary.
test("recovers a legacy ungraded row, persists rationale, and meters the request", async () => {
  expect(await recoverMissingGrade(false)).toEqual({graded:1,attempted:1});
  expect((await h.db.query("select fit_score,fit_summary,grading_state from jobs")).rows).toEqual([
    {fit_score:4,fit_summary:"Strong domain fit",grading_state:"graded"}]);
  expect(withBudget).toHaveBeenCalledWith(expect.objectContaining({action:"score-fit",isAdmin:false}));
  expect(await recoverMissingGrade(false)).toEqual({graded:0,attempted:0});
  expect(scoreFit).toHaveBeenCalledTimes(1);
});

// Mutation: discard the failure or bypass the provider pause on the next request.
test("failed credits persist a visible reason and stop subsequent paid attempts", async () => {
  vi.mocked(scoreFit).mockResolvedValue({score:0,rationale:"",error:"Add API credits",failureKind:"blocked"});
  expect(await recoverMissingGrade(false)).toMatchObject({graded:0,attempted:1,error:"Add API credits"});
  expect((await h.db.query("select grading_state,grading_error from jobs")).rows[0]).toEqual({grading_state:"failed",grading_error:"Add API credits"});
  await recoverMissingGrade(false);
  expect(scoreFit).toHaveBeenCalledTimes(1);
});

// Mutation: claim or call the model before checking the spending limit.
test("a capped budget leaves the queue and model untouched", async () => {
  h.capped=true;
  expect(await recoverMissingGrade(false)).toMatchObject({graded:0,attempted:0,error:"Spending limit reached"});
  expect(scoreFit).not.toHaveBeenCalled();
  expect((await h.db.query("select grading_attempts from jobs")).rows[0]).toEqual({grading_attempts:0});
});

// Mutation: count failed persistence as successful grading.
test("an empty-message write failure is not reported as recovered", async () => {
  h.writeFailure=true;
  expect(await recoverMissingGrade(false)).toMatchObject({graded:0,attempted:1,error:expect.any(String)});
  expect((await h.db.query("select fit_score from jobs")).rows[0]).toEqual({fit_score:null});
});

// Mutation: remove chosen-role guard from filing.
test("a chosen role keeps New even when its read posting scores poorly", async () => {
  await h.db.query(`update jobs set grading_chosen=true,posting='{"enrichedAt":"2026-09-11"}'`);
  vi.mocked(scoreFit).mockResolvedValue({score:2,rationale:"Weak fit"});
  await recoverMissingGrade(false);
  expect((await h.db.query("select status,fit_score from jobs")).rows[0]).toEqual({status:"New",fit_score:2});
});

// Mutation: remove the guarded final write after the API call.
test("a user grade entered during recovery wins", async () => {
  vi.mocked(scoreFit).mockImplementation(async () => {
    await h.db.query("update jobs set fit_score=5");
    return {score:2,rationale:"Late model answer"};
  });
  expect(await recoverMissingGrade(false)).toEqual({graded:0,attempted:1});
  expect((await h.db.query("select fit_score from jobs")).rows[0]).toEqual({fit_score:5});
});

// Mutation: insert the pause without requiring an owned lease in the failed CTE.
test("an obsolete blocked worker cannot pause resumed recovery", async () => {
  await recordGradeFailure('role','00000000-0000-0000-0000-000000000001',1,{kind:'blocked',message:'Old failure'});
  expect((await h.db.query("select * from app_settings")).rows).toEqual([]);
});

// Mutation: retain an expired lease while resetting the retry queue.
test("explicit resume invalidates expired leases before a new attempt can start", async () => {
  const lease='00000000-0000-0000-0000-000000000001';
  await h.db.query("update jobs set grading_state='running',grading_lease=$1,grading_next_at=now()-interval '1 minute'",[lease]);
  h.capped=true;
  await retryMissingGrades(true);
  await recordGradeFailure('role',lease,1,{kind:'blocked',message:'Old failure'});
  expect((await h.db.query("select * from app_settings")).rows).toEqual([]);
  expect((await h.db.query("select grading_lease from jobs")).rows[0]).toEqual({grading_lease:null});
});
