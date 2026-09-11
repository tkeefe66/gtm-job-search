import { afterAll, beforeAll, expect, test } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { CLAIM_GRADE_SQL, FINISH_GRADE_SQL, gradingFailure, retryDelayMinutes } from "./grading-policy";

const db = new PGlite();
const tenant = "00000000-0000-0000-0000-000000000001";
const lease = "00000000-0000-0000-0000-000000000010";
beforeAll(async () => {
  await db.exec(`create table jobs (
    id text primary key, tenant_id text, status text default 'New', fit_score int, fit_summary text,
    never_live boolean default false, created_at timestamptz default now(), updated_at timestamptz default now(),
    grading_state text default 'pending', grading_attempts int default 0,
    grading_next_at timestamptz, grading_error text, grading_lease uuid,
    grading_chosen boolean default false);
    create table app_settings (tenant_id text, key text, value jsonb, primary key(tenant_id,key));`);
});
afterAll(() => db.close());

// Mutation: remove fit_score/status/tenant/lease eligibility guards from CLAIM_GRADE_SQL.
test("claims only an eligible missing grade and excludes it while leased", async () => {
  await db.exec("delete from jobs");
  await db.query(`insert into jobs(id,tenant_id,status,fit_score,grading_next_at,grading_attempts) values
    ('manual',$1,'New',5,null,0), ('closed',$1,'Rejected',null,null,0),
    ('other','other','New',null,null,0), ('waiting',$1,'New',null,now()+interval '1 hour',1),
    ('exhausted',$1,'New',null,null,5), ('ready',$1,'New',null,null,0)`, [tenant]);
  const first = await db.query<{id:string}>(CLAIM_GRADE_SQL, [tenant, ['Rejected'], lease]);
  expect(first.rows.map(r => r.id)).toEqual(['ready']);
  expect((await db.query(CLAIM_GRADE_SQL, [tenant, ['Rejected'], lease])).rows).toEqual([]);
  await db.query("update jobs set grading_next_at=now()-interval '1 minute' where id='ready'");
  expect((await db.query(CLAIM_GRADE_SQL, [tenant, ['Rejected'], lease])).rows).toHaveLength(1);
});

// Mutation: remove score-null or lease guard from FINISH_GRADE_SQL.
test("late recovery cannot replace a manual grade or another worker's lease", async () => {
  await db.exec("delete from jobs");
  await db.query("insert into jobs(id,tenant_id,fit_score,grading_lease) values ('manual',$1,5,$2), ('stale',$1,null,null)", [tenant,lease]);
  for (const id of ['manual','stale']) {
    expect((await db.query(FINISH_GRADE_SQL, [tenant,id,lease,2,'Not Interested',['Rejected'],null])).rows).toEqual([]);
  }
  expect((await db.query<{fit_score:number}>("select fit_score from jobs where id='manual'")).rows[0].fit_score).toBe(5);
});

// Mutation: ignore grading_pause in CLAIM_GRADE_SQL.
test("a provider pause prevents buying another grade", async () => {
  await db.exec("delete from jobs");
  await db.query("insert into jobs(id,tenant_id) values ('ready',$1)", [tenant]);
  await db.query("insert into app_settings values ($1,'grading_pause','\"Add credits\"')", [tenant]);
  expect((await db.query(CLAIM_GRADE_SQL, [tenant, [], lease])).rows).toEqual([]);
});

// Captured production error text; provider internals must not reach the UI.
test("credit and auth errors pause recovery with safe actionable copy", () => {
  expect(gradingFailure({status:400, message:'Your credit balance is too low to access the Anthropic API.'})).toMatchObject({kind:'blocked'});
  expect(gradingFailure({status:401,message:'secret-value'})).toEqual({kind:'blocked',message:'Grading paused: check your API key in Settings, then retry missing grades.'});
  expect(gradingFailure(new Error('secret-value'))).toEqual({kind:'transient',message:'Grading failed temporarily. It will retry automatically.'});
  expect(retryDelayMinutes(1)).toBe(5);
  expect(retryDelayMinutes(5)).toBe(1440);
});
