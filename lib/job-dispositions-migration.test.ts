import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "vitest";
import { SOURCE_QUALITY_SQL } from "./job-disposition-store";
import { FINISH_GRADE_SQL } from "./grading-policy";
const a="00000000-0000-0000-0000-000000000001", b="00000000-0000-0000-0000-000000000002";
const sql=readFileSync(new URL("../db/migrations/024_job_dispositions.sql",import.meta.url),"utf8");

test("atomic dispositions track only future activity, freeze provenance, isolate tenants and preserve replay/reopen history",async()=>{
 const db=new PGlite();
 try {
  await db.exec(`create role app_rw; create table users(id uuid primary key);
   insert into users values('${a}'),('${b}');
   create table jobs(id uuid primary key default gen_random_uuid(),tenant_id uuid not null references users,
    company text default 'Example',role_title text default 'Director',status text default 'New',
    source text,source_url text,job_url text,created_at timestamptz default now(),never_live boolean default false,
    fit_score int,fit_summary text,grading_chosen boolean default false,grading_state text,grading_error text,
    grading_next_at timestamptz,grading_lease uuid,updated_at timestamptz default now());
   insert into jobs(id,tenant_id,status) values('${a}','${a}','Not Interested');
   alter table jobs enable row level security; alter table jobs force row level security;
   create policy tenant on jobs using(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) with check(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
   grant select,insert,update,delete on jobs to app_rw;`);
  await db.exec(sql); await db.exec(sql);
  expect((await db.query("select * from job_source_records")).rows).toEqual([]);
  expect((await db.query("select disposition from jobs")).rows).toEqual([{disposition:null}]);
  await db.exec(`set role app_rw; select set_config('app.tenant_id','${a}',false); update jobs set company='Legacy edited' where id='${a}';`);
  expect((await db.query("select * from job_source_records")).rows).toEqual([]);
  await db.exec(`select set_config('app.disposition_actor','user',false); update jobs set status='New' where id='${a}';`);
  expect((await db.query("select cohort from job_source_records")).rows).toEqual([{cohort:"legacy"}]);
  expect((await db.query("select previous_status,status from job_disposition_events")).rows).toEqual([{previous_status:"Not Interested",status:"New"}]);
  await db.exec(`select set_config('app.disposition_actor','',false);
   insert into jobs(id,tenant_id,source,source_url,job_url,never_live,status,disposition)
   values('${b}','${a}','Role Search','https://source.test/one','https://ats.test/one',true,'Posting Closed','job_not_found');`);
  expect((await db.query("select disposition,actor from job_disposition_events order by id desc limit 1")).rows).toEqual([{disposition:"job_not_found",actor:"automation"}]);
  await db.exec(`update jobs set source_url='https://changed.test',job_url='https://relink.test',company='Changed' where id='${b}';
   select set_config('app.disposition_actor','user',false);
   update jobs set status='New' where id='${b}';
   update jobs set status='Not Interested' where id='${b}';
   update jobs set status='Not Interested' where id='${b}';`);
  expect((await db.query("select source_url,company,cohort,never_live from job_source_records where job_id=$1",[b])).rows).toEqual([{source_url:"https://source.test/one",company:"Example",cohort:"new",never_live:true}]);
  expect((await db.query("select status,disposition,actor from job_disposition_events where source_record_id=(select id from job_source_records where job_id=$1) order by id",[b])).rows).toEqual([
   {status:"Posting Closed",disposition:"job_not_found",actor:"automation"},
   {status:"New",disposition:null,actor:"user"},
   {status:"Not Interested",disposition:"not_interested",actor:"user"},
  ]);
  await db.exec(`select set_config('app.tenant_id','${b}',false);`);
  expect((await db.query("select * from job_source_records")).rows).toEqual([]);
  expect((await db.query("select * from job_disposition_events")).rows).toEqual([]);
  await expect(db.exec(`insert into job_source_records(tenant_id,company,role_title,discovered_at,cohort) values('${a}','x','x',now(),'new')`)).rejects.toThrow();
  await db.exec("select set_config('app.tenant_id','',false)");
  expect((await db.query("select * from job_source_records")).rows).toEqual([]);
  await db.exec(`reset role; alter table job_disposition_events add constraint reject_test check(status<>'Applied'); set role app_rw; select set_config('app.tenant_id','${a}',false);`);
  await expect(db.exec(`update jobs set status='Applied' where id='${b}'`)).rejects.toThrow();
  expect((await db.query("select status from jobs where id=$1",[b])).rows).toEqual([{status:"Not Interested"}]);
  await expect(db.exec("update job_source_records set company='tamper'")).rejects.toThrow();
  await expect(db.exec("delete from job_disposition_events")).rejects.toThrow();
  await db.exec(`delete from jobs where id='${b}'`);
  expect((await db.query("select job_id from job_source_records where cohort='new'")).rows).toEqual([{job_id:null}]);
  expect((await db.query("select * from job_disposition_events")).rows).toHaveLength(4);
  // Actual grading SQL assigns automatic Not a fit even to a custom terminal status.
  await db.exec(`select set_config('app.disposition_actor','',false); update jobs set grading_lease='${b}' where id='${a}'`);
  await db.query(FINISH_GRADE_SQL,[a,a,b,2,'Custom filed',[],null]);
  expect((await db.query("select status,disposition,actor from job_disposition_events order by id desc limit 1")).rows).toEqual([{status:"Custom filed",disposition:"not_a_fit",actor:"automation"}]);
  // An explicit human confirmation changes attribution once. Notes and replay do not.
  await db.exec(`select set_config('app.disposition_actor','user',false); update jobs set company='Updated note equivalent' where id='${a}';`);
  expect((await db.query("select actor from job_disposition_events order by id desc limit 1")).rows).toEqual([{actor:"automation"}]);
  await db.exec(`select set_config('app.explicit_disposition','true',false); update jobs set disposition='not_a_fit' where id='${a}'; update jobs set disposition='not_a_fit' where id='${a}';`);
  expect((await db.query("select actor from job_disposition_events order by id desc limit 2")).rows).toEqual([{actor:"user"},{actor:"automation"}]);
  await db.exec("select set_config('app.explicit_disposition','',false)");
  // Correcting a disposition without changing status creates one event and keeps its reason.
  await db.exec(`select set_config('app.disposition_actor','user',false); update jobs set disposition='duplicate',disposition_reason=null where id='${a}';`);
  expect((await db.query("select previous_status,status,disposition,actor from job_disposition_events order by id desc limit 1")).rows).toEqual([{previous_status:"Custom filed",status:"Custom filed",disposition:"duplicate",actor:"user"}]);
  await db.exec(`insert into jobs(tenant_id,status) values('${a}','Not Interested'),('${a}','Posting Closed')`);
  expect((await db.query("select disposition,actor from job_disposition_events order by id desc limit 2")).rows).toEqual([{disposition:"posting_closed",actor:"user"},{disposition:"not_interested",actor:"user"}]);
  const report=await db.query<{records:Array<{job_id:string|null;disposition:string|null;event_count:number;discovered_at:string}>}>(SOURCE_QUALITY_SQL,[a]);
  expect(report.rows[0].records).toHaveLength(4);
  expect(report.rows[0].records.find(r=>r.job_id===a)).toMatchObject({disposition:"duplicate",event_count:4});
  expect(typeof report.rows[0].records[0].discovered_at).toBe("string");
  expect(report.rows[0].records.filter(r=>r.job_id===null)).toHaveLength(1);
  await db.exec(`select set_config('app.tenant_id','${b}',false)`);
  expect((await db.query<{records:unknown[]}>(SOURCE_QUALITY_SQL,[a])).rows[0].records).toEqual([]);
 } finally {await db.close();}
},20000);
