import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

// Execute production SQL against PostgreSQL with the repository's actual RLS policy.
// PGlite serializes transactions, so this proves SQL/rollback semantics, not pg lock scheduling.
let db: PGlite;
const tenantA = "00000000-0000-4000-8000-000000000001";
const tenantB = "00000000-0000-4000-8000-000000000002";
let actorId = tenantA;
const now = new Date();
vi.mock("@/lib/require-actor", () => ({ requireActor: async () => ({ tenantId: actorId, isAdmin: false }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase", () => {
  const tenantTransaction = async (id: string, fn: (q: (sql: string, args: unknown[]) => Promise<unknown>) => Promise<unknown>) => db.transaction(async (tx) => {
    await tx.query("select set_config('app.tenant_id', $1, true)", [id]);
    await tx.exec("set local role app_rw");
    return fn((sql, args) => tx.query(sql, args));
  });
  return { tenantTransaction, rawQuery: async (sql: string, args: unknown[] = [], tenantId?: string) => {
    try {
      const result = (tenantId ? await tenantTransaction(tenantId, q => q(sql, args)) : await db.query(sql, args)) as { rows: unknown[] };
      return { data: result.rows, error: null };
    } catch (e) { return { data: [], error: { message: (e as Error).message } }; }
  } };
});
import { reserveSpend, reconcileSpend, readSpent, advanceSpend } from "./usage-store";
import { saveSpendLimits, getOwnSpendOverview } from "@/app/actions/spend-limits";
import { rawQuery } from "./supabase";

beforeAll(async () => {
  db = new PGlite();
  await db.exec("create role app_rw; create table users (id uuid primary key, daily_budget_cents integer);");
  await db.exec(readFileSync("db/migrations/004_metering.sql", "utf8"));
  await db.exec(`create table app_settings (tenant_id uuid references users(id), key text, value jsonb not null, primary key(tenant_id,key));
    alter table app_settings enable row level security;
    alter table app_settings force row level security;
    create policy tenant_isolation on app_settings using (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
      with check (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
    grant select,insert,update,delete on app_settings to app_rw;`);
  await db.query("insert into users(id) values ($1),($2)", [tenantA, tenantB]);
});
afterAll(async () => { await db.close(); });
beforeEach(async () => { actorId = tenantA; await db.exec("truncate usage_events, usage_counters, app_settings"); });

const reserve = (overrides = {}) => reserveSpend({ tenantId: tenantA, estimateCents: 10, dailyCeilingCents: 100, monthlyCeilingCents: 500, now, ...overrides });
const record = (overrides = {}) => reconcileSpend({ tenantId: tenantA, estimateCents: 0, actualCents: 25, action: "fixture", searches: 0, inputTokens: 0, outputTokens: 0, billedTo: "tenant", now, ...overrides });

// Mutation: retain UPDATE-only reconciliation, losing first-time BYO spending.
test("first-use counters include history and the just-completed call", async () => {
  await db.query("insert into usage_events(tenant_id,action,cost_cents,occurred_at) values($1,'past',70,$2)", [tenantA, now.toISOString()]);
  expect((await readSpent(tenantA, now, "daily")).spentCents).toBe(70);
  expect(await record()).toEqual({});
  expect((await readSpent(tenantA, now, "daily")).spentCents).toBe(95);
  expect((await readSpent(tenantA, now, "monthly")).spentCents).toBe(95);
  expect((await reserve()).ok).toBe(false);
  expect((await readSpent(tenantB, now, "daily")).spentCents).toBe(0);
});

// Mutation: independently commit the daily reservation before refusing the month.
test("a monthly refusal rolls back the earlier daily reservation", async () => {
  await db.query("insert into usage_counters(tenant_id,period,spent_cents) values($1,$2,500)", [tenantA, now.toISOString().slice(0, 7)]);
  expect((await reserve()).reason).toBe("monthly");
  expect((await readSpent(tenantA, now, "daily")).spentCents).toBe(0);
});

// Mutation: skip the cap guard on the first insertion or treat zero like null.
test("zero pauses even on first use; a null daily limit retains the monthly guard", async () => {
  expect((await reserve({ dailyCeilingCents: 0, monthlyCeilingCents: null, estimateCents: 0 })).ok).toBe(false);
  expect((await reserve({ dailyCeilingCents: null, monthlyCeilingCents: 10 })).ok).toBe(true);
  expect((await reserve({ dailyCeilingCents: null, monthlyCeilingCents: 10, estimateCents: 0 })).reason).toBe("monthly");
  expect(await record({ estimateCents: 10, actualCents: 5 })).toEqual({});
  expect((await readSpent(tenantA, now, "daily")).spentCents).toBe(5);
  expect((await readSpent(tenantA, now, "monthly")).spentCents).toBe(5);
});

// Mutation: remove the guarded UPDATE, letting queued reservations exceed the cap.
test("only ten ten-cent reservations fit in a dollar", async () => {
  const results = await Promise.all(Array.from({ length: 20 }, () => reserve({ dailyCeilingCents: 100, monthlyCeilingCents: 100 })));
  expect(results.filter(result => result.ok)).toHaveLength(10);
  expect((await readSpent(tenantA, now, "daily")).spentCents).toBe(100);
});

// Mutation: update counters outside the event transaction.
test("event-write failure rolls back both counters", async () => {
  await db.exec("alter table usage_events add constraint fail_fixture check (action <> 'fixture')");
  try {
    expect((await record()).error).toBeDefined();
    expect((await readSpent(tenantA, now, "daily")).spentCents).toBe(0);
    expect((await readSpent(tenantA, now, "monthly")).spentCents).toBe(0);
  } finally { await db.exec("alter table usage_events drop constraint fail_fixture"); }
});

// Mutation: add completed response usage twice during final reconciliation.
test("response progress is visible immediately and final reconciliation does not double charge", async () => {
  expect((await reserve()).ok).toBe(true);
  expect(await advanceSpend({ tenantId: tenantA, deltaCents: 90, now })).toEqual({});
  expect((await readSpent(tenantA, now, "daily")).spentCents).toBe(100);
  expect((await reserve()).ok).toBe(false);
  expect(await record({ estimateCents: 100, actualCents: 100 })).toEqual({});
  expect((await readSpent(tenantA, now, "daily")).spentCents).toBe(100);
  expect((await db.query<{ cost_cents: number }>("select cost_cents from usage_events")).rows).toEqual([{ cost_cents: 100 }]);
});

// Mutation: accept client tenant identity or omit the transaction's RLS scope.
test("saved limits survive reload and remain isolated between users", async () => {
  expect(await saveSpendLimits({ dailyCents: 125, monthlyCents: 500, tenantId: tenantB } as never)).toEqual({});
  expect((await getOwnSpendOverview()).overview?.dailyCents).toBe(125);
  actorId = tenantB;
  expect((await getOwnSpendOverview()).overview?.dailyCents).toBeNull();
  expect((await rawQuery("select * from app_settings where tenant_id=$1", [tenantA], tenantB)).data).toEqual([]);
  expect((await rawQuery("insert into app_settings(tenant_id,key,value) values($1,$2,$3)", [tenantA, "attack", "{}"], tenantB)).error).not.toBeNull();
  actorId = tenantA;
  expect(await saveSpendLimits({ dailyCents: 0, monthlyCents: null })).toEqual({});
  expect((await getOwnSpendOverview()).overview?.dailyCents).toBe(0);
  expect(await saveSpendLimits({ dailyCents: null, monthlyCents: null })).toEqual({});
  expect((await getOwnSpendOverview()).overview?.dailyCents).toBeNull();
});
