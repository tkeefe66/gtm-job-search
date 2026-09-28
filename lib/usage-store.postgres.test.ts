import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";

// Opt-in through scripts/verify-postgres-concurrency.mjs. No production URL fallback.
const connectionString = process.env.COST_TEST_POSTGRES_URL;
const labels = new AsyncLocalStorage<string>();
const tenant = "00000000-0000-4000-8000-000000000001";
const now = new Date();
const day = now.toISOString().slice(0, 10);
const month = now.toISOString().slice(0, 7);
let pool: Pool;
let admin: Pool;
type QueryEvent = { label: string; pid: number; sql: string; args: unknown[] };
let events: QueryEvent[] = [];
let afterQuery: ((event: QueryEvent) => Promise<void>) | undefined;
const releases = new Set<() => void>();

vi.mock("./supabase", () => {
  async function tenantTransaction(id: string, fn: (q: (sql: string, args?: unknown[]) => Promise<unknown>) => Promise<unknown>) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.tenant_id',$1,true)", [id]);
      await client.query("set local role app_rw");
      const session = (await client.query("select pg_backend_pid() pid,current_user role,current_setting('app.tenant_id') tenant")).rows[0];
      expect(session).toMatchObject({ role: "app_rw", tenant: id });
      const result = await fn(async (sql, args = []) => {
        // Optional negative control changes only disposable-test SQL, never runtime files.
        const executedSql = process.env.COST_TEST_SQL_MUTATION === "remove-reservation-cap"
          ? sql.replace("and ($4::integer is null or (spent_cents < $4 and spent_cents + $3 <= $4))", "and ($4::integer is null or true)")
          : sql;
        const value = await client.query(executedSql, args);
        const event = { label: labels.getStore() ?? "unlabelled", pid: session.pid as number, sql, args };
        events.push(event);
        await afterQuery?.(event);
        return value;
      });
      await client.query("commit");
      return result;
    } catch (error) { await client.query("rollback"); throw error; }
    finally { client.release(); }
  }
  return { tenantTransaction, rawQuery: async (sql: string, args: unknown[] = [], id?: string) => {
    try {
      const result = await (id ? tenantTransaction(id, q => q(sql, args)) : admin.query(sql, args)) as { rows: unknown[] };
      return { data: result.rows, error: null };
    } catch (error) { return { data: [], error: { message: (error as Error).message } }; }
  } };
});

import { reserveSpend, reconcileSpend, readSpent } from "./usage-store";
import { beginAIRequest, recoverStaleAIOperations } from "./ai-ledger";

const run = <T>(label: string, fn: () => Promise<T>) => labels.run(label, fn);
async function until(check: () => boolean | Promise<boolean>, description: string) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out proving ${description}`);
}
function hold(label: string, matches: (event: QueryEvent) => boolean) {
  let entered = false;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  releases.add(release);
  afterQuery = async event => {
    if (!entered && event.label === label && matches(event)) { entered = true; await blocked; }
  };
  return { entered: () => until(() => entered, `${label} owns its row lock`), release };
}
async function lockWaiters(count: number) {
  let rows: { pid: number; blockers: number[] }[] = [];
  await until(async () => {
    rows = (await admin.query(`select pid,pg_blocking_pids(pid) blockers from pg_stat_activity
      where application_name='codex-cost-concurrency' and wait_event_type='Lock'`)).rows;
    return rows.length >= count;
  }, `${count} separate PostgreSQL backends waiting on real row locks`);
  expect(new Set(rows.map(row => row.pid)).size).toBeGreaterThanOrEqual(count);
  expect(rows.every(row => row.blockers.length > 0)).toBe(true);
  console.log(`Observed ${rows.length} distinct PostgreSQL lock waiters.`);
}
const reserve = (overrides = {}) => reserveSpend({ tenantId: tenant, estimateCents: 10, dailyCeilingCents: 100, monthlyCeilingCents: 500, now, ...overrides });
function operation(id = randomUUID()) {
  return { id, action: "crawl", workload: "background" as const, provider: "anthropic", model: "claude-sonnet-4-6", attribution: { company: "Synthetic Co" } };
}
const counterUpdates = (label: string) => events.filter(event => event.label === label && /^update usage_counters/.test(event.sql)).map(event => event.args[1]);

describe.skipIf(!connectionString)("real PostgreSQL accounting concurrency", () => {
  beforeAll(async () => {
    const url = new URL(connectionString!);
    if (url.hostname !== "127.0.0.1" || url.pathname !== "/codex_cost_concurrency" ||
        !/^codex-cost-concurrency-/.test(process.env.COST_TEST_DISPOSABLE_CONTAINER ?? "")) {
      throw new Error("Run through the disposable local PostgreSQL harness; refusing any other database.");
    }
    pool = new Pool({ connectionString, max: 24, application_name: "codex-cost-concurrency", statement_timeout: 8000, lock_timeout: 6000 });
    admin = new Pool({ connectionString, max: 2, application_name: "codex-cost-observer" });
    await admin.query("create role app_rw nosuperuser nobypassrls; create table users(id uuid primary key)");
    await admin.query(readFileSync("db/migrations/004_metering.sql", "utf8"));
    await admin.query(readFileSync("db/migrations/028_ai_request_ledger.sql", "utf8"));
    await admin.query("insert into users(id) values($1)", [tenant]);
  });
  beforeEach(async () => {
    events = []; afterQuery = undefined;
    await admin.query("truncate usage_events,usage_counters,ai_usage_requests,ai_operations");
  });
  afterEach(() => { for (const release of releases) release(); releases.clear(); afterQuery = undefined; });
  afterAll(async () => { await pool?.end(); await admin?.end(); });

  // Mutation: the guarded counter UPDATE becomes unguarded, admitting more than the cap after lock release.
  test("twenty simultaneously waiting reservations admit only ten at the overall dollar limit", async () => {
    const gate = hold("leader", event => /^update usage_counters/.test(event.sql) && event.args[1] === day);
    const first = run("leader", () => reserve({ monthlyCeilingCents: 100 }));
    await gate.entered();
    const others = Array.from({ length: 19 }, (_, i) => run(`follower-${i}`, () => reserve({ monthlyCeilingCents: 100 })));
    try { await lockWaiters(19); } finally { gate.release(); }
    const results = await Promise.all([first, ...others]);
    expect(results.every(result => result.error === undefined)).toBe(true);
    expect(results.filter(result => result.ok)).toHaveLength(10);
    expect(counterUpdates("leader")).toEqual([day, month]);
    expect((await readSpent(tenant, now, "daily")).spentCents).toBe(100);
    expect((await readSpent(tenant, now, "monthly")).spentCents).toBe(100);
  }, 20_000);

  // Mutation: background windows reserve independently or in a different order, leaking debits or deadlocking.
  test("background reservations lock all four windows in order and admit only their own allowance", async () => {
    const input = { backgroundLimits: { dailyCents: 20, monthlyCents: 500 } };
    const gate = hold("leader", event => /^update usage_counters/.test(event.sql) && event.args[1] === day);
    const first = run("leader", () => reserve(input));
    await gate.entered();
    const others = Array.from({ length: 7 }, (_, i) => run(`follower-${i}`, () => reserve(input)));
    try { await lockWaiters(7); } finally { gate.release(); }
    const results = await Promise.all([first, ...others]);
    expect(results.every(result => result.error === undefined)).toBe(true);
    expect(results.filter(result => result.ok)).toHaveLength(2);
    expect(results.filter(result => !result.ok).every(result => result.scope === "background")).toBe(true);
    expect(counterUpdates("leader")).toEqual([day, month, `background:${day}`, `background:${month}`]);
    for (const window of ["daily", "monthly"] as const) {
      expect((await readSpent(tenant, now, window)).spentCents).toBe(20);
      expect((await readSpent(tenant, now, window, "background")).spentCents).toBe(20);
    }
    expect((await reserve()).ok).toBe(true);
    expect((await readSpent(tenant, now, "monthly", "background")).spentCents).toBe(20);
  }, 20_000);

  // Mutation: failure in the fourth window leaves the first three debits committed.
  test("a waiting foreground reservation sees all earlier debits rolled back after background month refusal", async () => {
    await admin.query("insert into usage_counters(tenant_id,period,spent_cents) values($1,$2,90)", [tenant, `background:${month}`]);
    const gate = hold("refused", event => /^update usage_counters/.test(event.sql) && event.args[1] === `background:${day}`);
    const refused = run("refused", () => reserve({ estimateCents: 20, backgroundLimits: { dailyCents: 100, monthlyCents: 100 }, operation: operation() }));
    await gate.entered();
    const waiting = run("foreground", () => reserve());
    try { await lockWaiters(1); } finally { gate.release(); }
    expect(await refused).toMatchObject({ ok: false, reason: "monthly", scope: "background" });
    expect((await waiting).ok).toBe(true);
    expect((await readSpent(tenant, now, "daily")).spentCents).toBe(10);
    expect((await readSpent(tenant, now, "monthly")).spentCents).toBe(10);
    expect((await readSpent(tenant, now, "daily", "background")).spentCents).toBe(0);
    expect((await readSpent(tenant, now, "monthly", "background")).spentCents).toBe(90);
    expect((await admin.query("select * from ai_operations")).rows).toHaveLength(0);
  }, 20_000);

  // Mutation: remove the operation lock or settled guard, producing duplicate events/debits under simultaneous finalization.
  test("eight settlements contend on one operation and commit exactly one event and debit", async () => {
    const op = operation();
    await reserve({ operation: op, backgroundLimits: { dailyCents: 100, monthlyCents: 500 } });
    const input = { tenantId: tenant, operationId: op.id, workload: "background" as const, estimateCents: 10,
      actualCents: 25, costMicrousd: 250000, costComplete: true, action: "crawl", searches: 0, inputTokens: 0, outputTokens: 0,
      billedTo: "tenant" as const, now };
    const gate = hold("leader", event => /^select accounted_cents/.test(event.sql));
    const first = run("leader", () => reconcileSpend(input));
    await gate.entered();
    const others = Array.from({ length: 7 }, (_, i) => run(`follower-${i}`, () => reconcileSpend(input)));
    try { await lockWaiters(7); } finally { gate.release(); }
    expect(await Promise.all([first, ...others])).toEqual(Array.from({ length: 8 }, () => ({})));
    expect((await admin.query("select cost_cents,held_cents from usage_events")).rows).toEqual([{ cost_cents: 25, held_cents: 0 }]);
    expect(counterUpdates("leader")).toEqual([day, month, `background:${day}`, `background:${month}`]);
    for (const window of ["daily", "monthly"] as const) {
      expect((await readSpent(tenant, now, window)).spentCents).toBe(25);
      expect((await readSpent(tenant, now, window, "background")).spentCents).toBe(25);
    }
  }, 20_000);

  // Mutation: recovery ignores the admission heartbeat after waiting for the operation lock.
  test("admission winning the row lock prevents a blocked stale recovery from reclaiming its fresh request", async () => {
    const op = operation();
    await reserve({ operation: op, now: new Date(now.getTime() - 3600000) });
    const gate = hold("admission", event => /^select status,settled_at/.test(event.sql));
    const request = run("admission", () => beginAIRequest({ tenantId: tenant, operationId: op.id, provider: "anthropic", model: op.model }, { kind: "complete", maxTokens: 100 }));
    await gate.entered();
    const recovery = run("recovery", () => recoverStaleAIOperations(tenant, now));
    try { await lockWaiters(1); } finally { gate.release(); }
    expect(await request).toMatch(/^[0-9a-f-]{36}$/);
    expect(await recovery).toEqual({ recovered: 0 });
    expect((await admin.query("select state from ai_usage_requests")).rows).toEqual([{ state: "in_flight" }]);
    expect((await admin.query("select status,settled_at from ai_operations")).rows).toEqual([{ status: "running", settled_at: null }]);
  }, 20_000);

  // Mutation: admission ignores recovering status after waiting on recovery's uncommitted claim.
  test("recovery winning the row lock prevents a blocked admission from dispatching a late request", async () => {
    const op = operation();
    await reserve({ operation: op, now: new Date(now.getTime() - 3600000) });
    const gate = hold("recovery", event => /^update ai_operations o set status='recovering'/.test(event.sql));
    const recovery = run("recovery", () => recoverStaleAIOperations(tenant, now));
    await gate.entered();
    const admission = run("admission", () => beginAIRequest({ tenantId: tenant, operationId: op.id, provider: "anthropic", model: op.model }, { kind: "complete", maxTokens: 100 }))
      .then(value => ({ value }), error => ({ error: (error as Error).message }));
    try { await lockWaiters(1); } finally { gate.release(); }
    expect(await recovery).toEqual({ recovered: 1 });
    expect(await admission).toMatchObject({ error: expect.stringContaining("no longer active") });
    expect((await admin.query("select * from ai_usage_requests")).rows).toHaveLength(0);
    expect((await admin.query("select cost_complete,held_cents,cost_cents from usage_events")).rows).toEqual([{ cost_complete: true, held_cents: 0, cost_cents: 0 }]);
  }, 20_000);
});
