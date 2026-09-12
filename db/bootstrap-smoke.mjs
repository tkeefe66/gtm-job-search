// TEST_DATABASE_URL=postgres://owner@localhost:PORT/EMPTY_TEST_DB node db/bootstrap-smoke.mjs
// Uses only a deliberately supplied LOCAL disposable database; never DATABASE_URL.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";
import { migrateDatabase } from "./migration-runner.mjs";
import { provisionAdmin } from "./provision-admin.mjs";

const url = new URL(process.env.TEST_DATABASE_URL || "http://missing");
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !url.pathname.includes('test')) {
  throw new Error("Set TEST_DATABASE_URL to an empty local database with 'test' in its name.");
}
const client = new pg.Client({ connectionString: url.toString() });
await client.connect();
try {
  assert.equal((await client.query("select 1 from pg_tables where schemaname='public'")).rowCount, 0,
    "Smoke test requires an empty public schema; it never resets an existing database.");
  // Mutation caught: bootstrap creates jobs_missing_grades before tenant_id.
  await migrateDatabase(client, { bootstrap: true });
  const files = readdirSync(new URL('./migrations/', import.meta.url)).filter(f => f.endsWith('.sql'));
  assert.equal((await client.query('select count(*)::int n from schema_migrations')).rows[0].n, files.length + 1);
  assert.equal((await client.query('select count(*)::int n from users')).rows[0].n, 0);
  assert.equal((await client.query("select to_regclass('insights_cache') v")).rows[0].v, null);
  // Mutation caught: rerunning baseline recreates removed tables or replaces grants.
  await migrateDatabase(client, { bootstrap: true });
  await client.query('grant select, insert, update, delete on schema_migrations to app_rw');
  await migrateDatabase(client);
  assert.equal((await client.query("select to_regclass('insights_cache') v")).rows[0].v, null);
  assert.equal((await client.query("select has_column_privilege('app_rw','users','role','UPDATE') v")).rows[0].v, false);
  assert.equal((await client.query("select has_table_privilege('app_rw','schema_migrations','INSERT') v")).rows[0].v, false);
  await assert.rejects(() => provisionAdmin(client, 'bootstrap-owner@example.test'), /Sign in/);

  // Synthetic adapter-shaped signup, not a real OAuth/network validation.
  await client.query('set role app_rw');
  const a = (await client.query(`insert into users(name,email,"emailVerified",image)
    values ('Owner','bootstrap-owner@example.test',null,null) returning id`)).rows[0].id;
  const b = (await client.query(`insert into users(name,email,"emailVerified",image)
    values ('Other','bootstrap-other@example.test',null,null) returning id`)).rows[0].id;
  await assert.rejects(() => client.query("update users set role='admin' where id=$1", [a]), /permission denied/);
  await client.query(`insert into accounts("userId",type,provider,"providerAccountId") values ($1,'oauth','google','synthetic-sub')`, [a]);
  await client.query("update users set google_sub='synthetic-sub' where id=$1", [a]);
  await client.query('reset role');
  await provisionAdmin(client, 'bootstrap-owner@example.test');
  await provisionAdmin(client, 'bootstrap-owner@example.test');
  assert.equal((await client.query('select role from users where id=$1', [a])).rows[0].role, 'admin');

  // Mutation caught: absent RLS or grants permit another tenant to read/write rows.
  await client.query('set role app_rw');
  for (const id of [a,b]) {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id',$1,true)", [id]);
    await client.query("insert into jobs(tenant_id,company,role_title) values ($1,'Shared company','Engineer')", [id]);
    await client.query("insert into app_settings(tenant_id,key,value) values ($1,'fitBrain','\"Own profile\"')", [id]);
    await client.query('commit');
  }
  assert.equal((await client.query('select * from jobs')).rowCount, 0);
  await client.query('begin');
  await client.query("select set_config('app.tenant_id',$1,true)", [a]);
  assert.equal((await client.query('select * from jobs')).rowCount, 1);
  assert.equal((await client.query('select * from app_settings')).rowCount, 1);
  assert.equal((await client.query("update jobs set notes='Mine' where tenant_id=$1", [a])).rowCount, 1);
  assert.equal((await client.query("delete from jobs where tenant_id=$1", [b])).rowCount, 0);
  await client.query('commit');
  await assert.rejects(() => client.query("insert into jobs(tenant_id,company,role_title) values ($1,'Wrong','Wrong')", [b]), /row-level security/);
  await client.query('reset role');

  // Mutation caught: removing either owner guard silently adopts legacy rows.
  for (const [migration, tables] of [
    ['001_tenant_id.sql', ['jobs','watchlist','app_settings','insights_cache']],
    ['002_scope_caches.sql', ['discovered_roles','discovered_startups','role_searches','crawl_runs']],
  ]) {
    await client.query('begin');
    await client.query('create schema bootstrap_guard_test');
    await client.query('set local search_path = bootstrap_guard_test');
    await client.query('create table users(id uuid, role text, created_at timestamptz)');
    for (const table of tables) await client.query(`create table ${table}(id int)`);
    await client.query(`insert into ${tables[0]} values(1)`);
    await assert.rejects(() => client.query(readFileSync(new URL(`./migrations/${migration}`, import.meta.url), 'utf8')), /no admin user/);
    await client.query('rollback');
  }
  // Mutation caught: empty-table repair discards historical backfill/ownership.
  await client.query('begin');
  await client.query('create schema bootstrap_upgrade_test');
  await client.query('set local search_path = bootstrap_upgrade_test');
  await client.query(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  const owner = (await client.query("insert into users(email,role) values('legacy@example.test','admin') returning id")).rows[0].id;
  await client.query("insert into jobs(company,role_title,notes) values('Legacy','Engineer','Keep my notes')");
  await client.query("insert into crawl_runs(company,status) values('Legacy','success')");
  for (const migration of ['001_tenant_id.sql','002_scope_caches.sql']) {
    await client.query(readFileSync(new URL(`./migrations/${migration}`, import.meta.url), 'utf8'));
  }
  assert.deepEqual((await client.query('select tenant_id,notes from jobs')).rows, [{tenant_id:owner,notes:'Keep my notes'}]);
  assert.equal((await client.query('select tenant_id from crawl_runs')).rows[0].tenant_id,owner);
  await client.query('rollback');
  console.log('PASS: empty bootstrap, all migrations, repeatability, linked admin provisioning, app-role CRUD/RLS, legacy-owner refusal.');
} finally { await client.end(); }
