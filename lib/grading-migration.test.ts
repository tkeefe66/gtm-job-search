import {readFileSync} from "node:fs";
import {PGlite} from "@electric-sql/pglite";
import {expect,test} from "vitest";

// Mutation: omit provenance backfill or replace existing grades in migration.
test("migration preserves grades and manual provenance while queueing the old backlog", async()=>{
  const db=new PGlite();
  try {
    await db.exec(`create table jobs(id text,tenant_id text,source text,fit_score int,
      never_live boolean default false,created_at timestamptz default now());
      insert into jobs(id,source,fit_score) values
        ('manual','Added by URL',null),('search','Role Search',null),('graded','Role Search',5);`);
    const sql=readFileSync(new URL("../db/migrations/022_grading_recovery.sql",import.meta.url),"utf8");
    await db.exec(sql);
    await db.exec(sql);
    expect((await db.query("select id,fit_score,grading_chosen,grading_state from jobs order by id")).rows).toEqual([
      {id:'graded',fit_score:5,grading_chosen:false,grading_state:'pending'},
      {id:'manual',fit_score:null,grading_chosen:true,grading_state:'pending'},
      {id:'search',fit_score:null,grading_chosen:false,grading_state:'pending'},
    ]);
  } finally {await db.close();}
});
