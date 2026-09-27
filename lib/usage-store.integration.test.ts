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
import { saveSpendLimits, saveBackgroundSpendLimits, getOwnSpendOverview } from "@/app/actions/spend-limits";
import { rawQuery } from "./supabase";
import { beginAIRequest, finishAIRequest, markAIRequestUnknown, recoverStaleAIOperations, readCompanySpendSummaries } from "./ai-ledger";
import { crawlPolicyOutcome } from "./crawl-policy";
import { withAIAttribution } from "./ai-attribution";

beforeAll(async () => {
  db = new PGlite();
  await db.exec("create role app_rw; create table users (id uuid primary key, daily_budget_cents integer);");
  await db.exec(readFileSync("db/migrations/004_metering.sql", "utf8"));
  await db.exec(readFileSync("db/migrations/028_ai_request_ledger.sql", "utf8"));
  await db.exec(`create table watchlist(tenant_id uuid references users(id),company text,last_checked_at timestamptz,crawl_interval_days integer default 7,primary key(tenant_id,company));
    grant select,insert,update,delete on watchlist to app_rw;`);
  await db.exec(readFileSync("db/migrations/027_background_crawl_policy.sql", "utf8"));
  await db.exec(`create table app_settings (tenant_id uuid references users(id), key text, value jsonb not null, primary key(tenant_id,key));
    alter table app_settings enable row level security;
    alter table app_settings force row level security;
    create policy tenant_isolation on app_settings using (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
      with check (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
    grant select,insert,update,delete on app_settings to app_rw;`);
  await db.query("insert into users(id) values ($1),($2)", [tenantA, tenantB]);
});
afterAll(async () => { await db.close(); });
beforeEach(async () => { actorId = tenantA; await db.exec("truncate usage_events, usage_counters, app_settings, ai_usage_requests, ai_operations, watchlist"); });

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

// Mutation: reserve background separately and leave overall debits after a background-month refusal.
test("background monthly refusal rolls back all earlier window debits", async () => {
  await db.query("insert into usage_events(tenant_id,action,cost_cents,occurred_at) values($1,'crawl',75,$2)", [tenantA,now.toISOString()]);
  const res=await reserve({backgroundLimits:{dailyCents:100,monthlyCents:80}});
  expect(res).toMatchObject({ok:false,reason:"monthly",scope:"background"});
  expect((await readSpent(tenantA,now,"daily")).spentCents).toBe(75);
  expect((await readSpent(tenantA,now,"monthly","background")).spentCents).toBe(75);
  expect((await db.query("select * from usage_counters")).rows).toHaveLength(0);
});

// Mutation: infer all old score-fit usage as automatic or silently replace the user's overall limits.
test("background defaults are separate and history includes only known automatic calls", async () => {
  for(const [action,cost] of [["crawl",75],["score-fit",35],["resume-chat",40]] as const)
    await db.query("insert into usage_events(tenant_id,action,cost_cents,occurred_at) values($1,$2,$3,$4)",[tenantA,action,cost,now.toISOString()]);
  expect((await readSpent(tenantA,now,"monthly","background")).spentCents).toBe(75);
  expect((await getOwnSpendOverview()).overview?.background).toMatchObject({dailyCents:100,monthlyCents:1000,usesDefaults:true});
  expect(await saveSpendLimits({dailyCents:2000,monthlyCents:10000})).toEqual({});
  expect(await saveBackgroundSpendLimits({dailyCents:0,monthlyCents:null})).toEqual({});
  expect((await getOwnSpendOverview()).overview).toMatchObject({dailyCents:2000,monthlyCents:10000,background:{dailyCents:0,monthlyCents:null,usesDefaults:false}});
});

const operationId="10000000-0000-4000-8000-000000000001";
const operation={id:operationId,action:"crawl",workload:"background" as const,provider:"anthropic",model:"claude-sonnet-4-6",attribution:{company:"Synthetic Co"}};
// Mutation: unknown provider usage reconciles the operation reservation to a fabricated zero.
test("unknown operation retains its reservation and repeated settlement never double charges", async () => {
  expect((await reserve({operation,backgroundLimits:{dailyCents:100,monthlyCents:500}})).ok).toBe(true);
  const finish={operationId,workload:"background",actualCents:0,estimateCents:10,costMicrousd:0,costComplete:false};
  expect(await record(finish)).toEqual({});
  expect((await readSpent(tenantA,now,"monthly")).spentCents).toBe(10);
  expect((await readSpent(tenantA,now,"monthly","background")).spentCents).toBe(10);
  expect(await record(finish)).toEqual({});
  expect((await readSpent(tenantA,now,"monthly")).spentCents).toBe(10);
  expect((await db.query("select cost_complete,held_cents from usage_events")).rows).toEqual([{cost_complete:false,held_cents:10}]);
});

// Mutation: cross-tenant request references accepted without the composite tenant-operation key.
test("ledger RLS and tenant-operation foreign key refuse cross-tenant writes", async () => {
  await reserve({operation});
  expect((await rawQuery("select * from ai_operations where tenant_id=$1",[tenantA],tenantB)).data).toEqual([]);
  const attempted=await rawQuery(`insert into ai_usage_requests(id,tenant_id,operation_id,provider,model,kind,max_tokens)
    values($1,$2,$3,'anthropic','test','complete',10)`,["20000000-0000-4000-8000-000000000001",tenantB,operationId],tenantB);
  expect(attempted.error).not.toBeNull();
});

const ledger={tenantId:tenantA,operationId,provider:"anthropic" as const,model:"claude-sonnet-4-6"};
// Mutation: omit price snapshot and safe provider identifiers on failed requests.
test("unknown requests retain pre-dispatch prices and only safe provider error metadata", async()=>{
  await reserve({operation});
  const id=await beginAIRequest(ledger,{kind:"search",maxTokens:100,maxSearches:5,searchMode:"filtered"},{company:"Synthetic Co",phase:"listing"});
  const started=(await db.query<{pricing_snapshot:unknown;state:string}>("select pricing_snapshot,state from ai_usage_requests")).rows[0];
  expect(started.pricing_snapshot).not.toBeNull();expect(started.state).toBe("in_flight");
  await markAIRequestUnknown(ledger,id,"provider_outcome_unknown",{providerRequestId:"req_fixture",providerResponseId:"msg_fixture",stopReason:"max_tokens",message:"secret raw body"});
  const row=(await db.query("select * from ai_usage_requests")).rows[0];
  expect(row).toMatchObject({state:"unknown",cost_microusd:null,provider_request_id:"req_fixture",provider_response_id:"msg_fixture",stop_reason:"max_tokens"});
  expect(JSON.stringify(row)).not.toContain("secret raw body");
});

// Mutation: stale recovery releases uncertain cost, retries AI, or changes platform billing to tenant.
test("interrupted operations settle once with platform attribution and preserve a held reservation",async()=>{
  const old=new Date(now.getTime()-3600000);
  await reserve({operation:{...operation,billedTo:"platform"},now:old});
  await beginAIRequest(ledger,{kind:"complete",maxTokens:100});
  await db.query("update ai_operations set last_activity_at=$1",[old.toISOString()]);
  await db.query("update ai_usage_requests set started_at=$1",[old.toISOString()]);
  expect(await recoverStaleAIOperations(tenantA,now)).toEqual({recovered:1});
  expect(await recoverStaleAIOperations(tenantA,now)).toEqual({recovered:0});
  expect((await db.query("select billed_to,held_cents,cost_complete from usage_events")).rows).toEqual([{billed_to:"platform",held_cents:10,cost_complete:false}]);
  expect((await db.query("select state from ai_usage_requests")).rows).toEqual([{state:"unknown"}]);
  await expect(beginAIRequest(ledger,{kind:"complete",maxTokens:100})).rejects.toThrow("no longer active");
});

// Mutation: recover by operation creation time and reclaim a fresh request in a long-running operation.
test("a recent dispatch protects an older operation from stale recovery",async()=>{
  const old=new Date(now.getTime()-3600000);
  await reserve({operation,now:old});
  await beginAIRequest(ledger,{kind:"complete",maxTokens:100});
  // Defend even against a missed heartbeat: fresh in-flight request is independent evidence.
  await db.query("update ai_operations set last_activity_at=$1",[old.toISOString()]);
  expect(await recoverStaleAIOperations(tenantA,now)).toEqual({recovered:0});
  expect((await db.query("select state from ai_usage_requests")).rows).toEqual([{state:"in_flight"}]);
  expect((await db.query("select settled_at from ai_operations")).rows).toEqual([{settled_at:null}]);
});

// Mutation: a queued provider dispatch enters an operation already claimed by recovery.
test("recovery and new-request admission cannot both own an idle operation",async()=>{
  const old=new Date(now.getTime()-3600000);
  await reserve({operation,now:old});
  const results=await Promise.allSettled([
    recoverStaleAIOperations(tenantA,now),
    beginAIRequest(ledger,{kind:"complete",maxTokens:100}),
  ]);
  const recovered=results[0].status==="fulfilled"?results[0].value as {recovered:number}:null;
  if(recovered?.recovered===1)expect(results[1].status).toBe("rejected");
  else {
    expect(results[1].status).toBe("fulfilled");
    expect((await db.query("select settled_at from ai_operations")).rows[0].settled_at).toBeNull();
  }
});

// Mutation: mutable global company metadata leaks between concurrently running requests.
test("concurrent attribution is immutable and attached before provider dispatch",async()=>{
  await reserve({operation});
  await Promise.all(["First Synthetic","Second Synthetic"].map(company=>withAIAttribution({company,phase:"listing"},async()=>{
    await Promise.resolve();return beginAIRequest(ledger,{kind:"complete",maxTokens:100});
  })));
  expect((await db.query<{company:string}>("select company from ai_usage_requests order by company")).rows.map(r=>r.company)).toEqual(["First Synthetic","Second Synthetic"]);
});

// Mutation: independent background guards allow concurrent reservations beyond the sublimit.
test("queued background reservations share their own atomic allowance",async()=>{
  const attempts=await Promise.all(Array.from({length:8},()=>reserve({backgroundLimits:{dailyCents:20,monthlyCents:500}})));
  expect(attempts.filter(r=>r.ok)).toHaveLength(2);
  expect((await readSpent(tenantA,now,"daily")).spentCents).toBe(20);
  expect((await readSpent(tenantA,now,"daily","background")).spentCents).toBe(20);
  expect((await reserve()).ok).toBe(true);
});

// Mutation: suppress known partial cost as null or present unknown-only history as zero.
test("company summary preserves known partial amounts and explicitly unknown totals",async()=>{
  await db.query("insert into watchlist(tenant_id,company) values($1,'Synthetic Co'),($1,'Unknown Only')",[tenantA]);
  await reserve({operation});
  const id=await beginAIRequest(ledger,{kind:"complete",maxTokens:100},{company:"Synthetic Co"});
  await finishAIRequest(ledger,id,{text:"unused",stopReason:"end_turn",usage:{inputTokens:1,cachedInputTokens:0,outputTokens:0,searches:0}},3);
  const unknown=await beginAIRequest(ledger,{kind:"complete",maxTokens:100},{company:"Synthetic Co"});
  await markAIRequestUnknown(ledger,unknown);
  await record({operationId,costMicrousd:3,costComplete:false,actualCents:1,resultStatus:"partial",newRoles:1});
  const result=await readCompanySpendSummaries(tenantA,now);
  expect(result.error).toBeUndefined();
  expect(result.summaries.find(s=>s.company==="Synthetic Co")).toMatchObject({knownCostMicrousd:3,unknownRequests:1,latest:{costMicrousd:3,costComplete:false,status:"partial",newRoles:1}});
  expect(result.summaries.find(s=>s.company==="Unknown Only")).toMatchObject({knownCostMicrousd:null,latest:null});
});

// Mutation: latest cost uses the operation's unsettled zero instead of already recorded request costs.
test("latest company cost shows known running requests and preserves unknown-only versus free",async()=>{
  await db.query("insert into watchlist(tenant_id,company) values($1,'Synthetic Co'),($1,'Unknown Only'),($1,'Free Check')",[tenantA]);
  await reserve({operation});
  const id=await beginAIRequest(ledger,{kind:"complete",maxTokens:100},{company:"Synthetic Co"});
  await finishAIRequest(ledger,id,{text:"unused",stopReason:"end_turn",usage:{inputTokens:1,cachedInputTokens:0,outputTokens:0,searches:0}},3);
  let result=await readCompanySpendSummaries(tenantA,now);
  expect(result.error).toBeUndefined();
  expect(result.summaries.find(s=>s.company==="Synthetic Co")?.latest).toMatchObject({costMicrousd:3,costComplete:false});

  // An operation may preserve a larger measured amount after request-detail persistence failed.
  await db.query("update ai_operations set known_cost_microusd=7 where tenant_id=$1 and id=$2",[tenantA,operationId]);
  result=await readCompanySpendSummaries(tenantA,now);
  expect(result.summaries.find(s=>s.company==="Synthetic Co")?.latest).toMatchObject({costMicrousd:7,costComplete:false});

  const unknownId="10000000-0000-4000-8000-000000000002";
  await reserve({operation:{...operation,id:unknownId,attribution:{company:"Unknown Only"}}});
  const unknown=await beginAIRequest({...ledger,operationId:unknownId},{kind:"complete",maxTokens:100},{company:"Unknown Only"});
  await markAIRequestUnknown({...ledger,operationId:unknownId},unknown);
  const freeId="10000000-0000-4000-8000-000000000003";
  await reserve({operation:{...operation,id:freeId,attribution:{company:"Free Check"}}});
  await record({operationId:freeId,estimateCents:10,actualCents:0,costMicrousd:0,costComplete:true});
  result=await readCompanySpendSummaries(tenantA,now);
  expect(result.summaries.find(s=>s.company==="Unknown Only")?.latest).toMatchObject({costMicrousd:null,costComplete:false});
  expect(result.summaries.find(s=>s.company==="Free Check")?.latest).toMatchObject({costMicrousd:0,costComplete:true});
});

// Mutation: skip stamps a successful check or holds all direct checks until model backoff expires.
test("policy persists separate attempt and success clocks while keeping free checks scheduled",async()=>{
  await db.query("insert into watchlist(tenant_id,company,crawl_interval_days,consecutive_model_failures) values($1,'Synthetic Co',1,1)",[tenantA]);
  expect(await crawlPolicyOutcome(tenantA,"Synthetic Co",{trigger:"automatic",modelAttempt:"failure",status:"error",now})).toEqual({error:undefined});
  const first=(await db.query("select * from watchlist")).rows[0];
  expect(first.last_successful_check_at).toBeNull();expect(first.consecutive_model_failures).toBe(2);
  expect(new Date(first.next_attempt_at as string).getTime()).toBe(now.getTime()+86400000);
  expect(new Date(first.model_retry_after as string).getTime()).toBe(now.getTime()+7*86400000);
  await crawlPolicyOutcome(tenantA,"Synthetic Co",{trigger:"automatic",modelAttempt:"none",status:"unchanged",now});
  const second=(await db.query("select * from watchlist")).rows[0];
  expect(second.last_successful_check_at).not.toBeNull();expect(second.consecutive_model_failures).toBe(2);
});
