import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { expect, test } from "vitest";
import { READINESS_SCHEMA_SQL } from "./readiness";

// Executes the real fresh-install chain, then replays only the additive upgrade.
// Mutation caught: missing grants/RLS, invalid schema order, or a request FK
// that permits a tenant to attach an attempt to another tenant's operation.
test("fresh schema and repeated cost migrations preserve data and enforce tenant ownership", async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  const a = "00000000-0000-4000-8000-000000000001";
  const b = "00000000-0000-4000-8000-000000000002";
  const op = "00000000-0000-4000-8000-000000000010";
  try {
    await db.exec(readFileSync("db/schema.sql", "utf8"));
    const migrations = readdirSync("db/migrations").filter((file) => file.endsWith(".sql")).sort();
    for (const file of migrations) await db.exec(readFileSync(`db/migrations/${file}`, "utf8"));
    await db.query("insert into users(id,email) values($1,'a@example.test'),($2,'b@example.test')", [a, b]);
    await db.query("insert into watchlist(tenant_id,company,last_checked_at,last_crawl_status) values($1,'Example employer','2026-09-25','error')", [a]);
    await db.query("insert into usage_events(tenant_id,action,cost_cents) values($1,'crawl',50),($1,'score-fit',25)", [a]);
    for (let pass = 0; pass < 2; pass++) for (const file of migrations.filter((file) => /^02[678]_/.test(file)))
      await db.exec(readFileSync(`db/migrations/${file}`, "utf8"));
    expect((await db.query("select company,allow_paid_search,last_crawl_status,last_successful_check_at from watchlist")).rows).toEqual([
      { company: "Example employer", allow_paid_search: false, last_crawl_status: "error", last_successful_check_at: null },
    ]);
    expect((await db.query("select action,workload,cost_cents,cost_microusd from usage_events order by action")).rows).toEqual([
      { action: "crawl", workload: "background", cost_cents: 50, cost_microusd: null },
      { action: "score-fit", workload: null, cost_cents: 25, cost_microusd: null },
    ]);
    await db.exec("set role app_rw");
    expect((await db.query(READINESS_SCHEMA_SQL)).rows).toEqual([]);
    await db.query("select set_config('app.tenant_id',$1,false)", [a]);
    await db.query("insert into ai_operations(id,tenant_id,action,workload,provider,model,started_at,last_activity_at) values($1,$2,'crawl','background','anthropic','example',now(),now())", [op, a]);
    await db.query("insert into ai_usage_requests(id,tenant_id,operation_id,provider,model,kind,max_tokens) values($1,$2,$3,'anthropic','example','complete',100)", [b, a, op]);
    await db.query("insert into company_crawl_snapshots(tenant_id,company_key,source_key,criteria_fingerprint,parser_version,content_fingerprint,captured_at) values($1,'example','source','criteria',1,'content',now())", [a]);
    await db.query("select set_config('app.tenant_id',$1,false)", [b]);
    for (const table of ["ai_operations", "ai_usage_requests", "company_crawl_snapshots"])
      expect((await db.query(`select * from ${table}`)).rows).toEqual([]);
    await expect(db.query("insert into ai_usage_requests(id,tenant_id,operation_id,provider,model,kind,max_tokens) values($1,$2,$3,'anthropic','example','complete',100)", [a, b, op])).rejects.toThrow();
    await expect(db.query("insert into company_crawl_snapshots(tenant_id,company_key,source_key,criteria_fingerprint,parser_version,content_fingerprint,captured_at) values($1,'forged','source','criteria',1,'content',now())", [a])).rejects.toThrow();
  } finally { await db.close(); }
}, 20_000);
