import { rawQuery, tenantTransaction } from "@/lib/supabase";
import { billingPeriod, dailyPeriod } from "@/lib/budget";
import type { AIAttribution } from "./ai-attribution";

export type SpendWorkload = "foreground" | "background";
export type SpendWindow = "daily" | "monthly";
export interface OperationReservation {
  id: string; action: string; workload: SpendWorkload; provider: string; model: string; attribution: AIAttribution; billedTo?: "platform"|"tenant";
}
const RESERVE_SQL = `update usage_counters set spent_cents = spent_cents + $3, updated_at = now()
  where tenant_id = $1 and period = $2
    and ($4::integer is null or (spent_cents < $4 and spent_cents + $3 <= $4)) returning spent_cents`;
function periodBounds(now: Date, window: SpendWindow): [string,string] {
  const start = window === "daily" ? new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate())) : new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1));
  const end = window === "daily" ? new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()+1)) : new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+1,1));
  return [start.toISOString(),end.toISOString()];
}
function periodFor(now: Date, window: SpendWindow, background = false): string {
  return `${background ? "background:" : ""}${window === "daily" ? dailyPeriod(now) : billingPeriod(now)}`;
}
// Legacy non-ledger callers keep their schema-compatible path. New operations include
// held uncertainty in history, and only known automatic origins seed background usage.
function seedSql(background: boolean, ledger = false): string {
  return `insert into usage_counters(tenant_id,period,spent_cents)
    select $1,$2,coalesce(sum(cost_cents + held_cents),0)::integer from usage_events
    where tenant_id=$1 and occurred_at >= $3::timestamptz and occurred_at < $4::timestamptz
    ${background ? "and (workload = 'background' or (workload is null and action = 'crawl'))" : ""}
    on conflict(tenant_id,period) do nothing`;
}
export interface ReserveResult { ok: boolean; spentCents: number; reason?: SpendWindow; scope?: "overall"|"background"; availableCents?: number; error?: string }
class BudgetRefused extends Error {
  constructor(readonly reason: SpendWindow,readonly scope: "overall"|"background") { super("Spending limit reached"); }
}
export async function reserveSpend(input: {
  tenantId: string; estimateCents: number; dailyCeilingCents: number|null; monthlyCeilingCents: number|null; now: Date;
  backgroundLimits?: {dailyCents:number|null;monthlyCents:number|null}; operation?: OperationReservation;
}): Promise<ReserveResult> {
  try { return await tenantTransaction(input.tenantId, async q => {
    // Every caller uses this lock order. A later refusal throws and rolls back all debits.
    const windows: {reason:SpendWindow;period:string;ceiling:number|null;background:boolean}[] = [
      {reason:"daily",period:dailyPeriod(input.now),ceiling:input.dailyCeilingCents,background:false},
      {reason:"monthly",period:billingPeriod(input.now),ceiling:input.monthlyCeilingCents,background:false},
    ];
    if (input.backgroundLimits) windows.push(
      {reason:"daily",period:periodFor(input.now,"daily",true),ceiling:input.backgroundLimits.dailyCents,background:true},
      {reason:"monthly",period:periodFor(input.now,"monthly",true),ceiling:input.backgroundLimits.monthlyCents,background:true});
    let availableCents = Infinity;
    for (const w of windows) {
      await q(seedSql(w.background,!!input.operation),[input.tenantId,w.period,...periodBounds(input.now,w.reason)]);
      const r = await q(RESERVE_SQL,[input.tenantId,w.period,input.estimateCents,w.ceiling]);
      if (!r.rows.length) throw new BudgetRefused(w.reason,w.background ? "background":"overall");
      if (w.ceiling !== null) availableCents=Math.min(availableCents,w.ceiling-Number(r.rows[0].spent_cents)+input.estimateCents);
    }
    if (input.operation) {
      const o=input.operation,a=o.attribution;
      await q(`insert into ai_operations(id,tenant_id,action,workload,provider,model,company,crawl_run_id,job_id,trigger,started_at,reserved_cents,accounted_cents,billed_to,last_activity_at)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$13,$11)`,
        [o.id,input.tenantId,o.action,o.workload,o.provider,o.model,a.company??null,a.crawlRunId??null,a.jobId??null,a.trigger??null,input.now.toISOString(),input.estimateCents,o.billedTo??"tenant"]);
    }
    return {ok:true,spentCents:input.estimateCents,availableCents};
  }); } catch(e) {
    if(e instanceof BudgetRefused) return {ok:false,spentCents:0,reason:e.reason,...(e.scope==="background"?{scope:e.scope}:{})};
    return {ok:false,spentCents:0,error:e instanceof Error?e.message:String(e)};
  }
}

export async function advanceSpend(input: {tenantId:string;deltaCents:number;now:Date;workload?:SpendWorkload;operationId?:string;targetCents?:number}):Promise<{error?:string}> {
  try { await tenantTransaction(input.tenantId,async q=>{
    let delta=input.deltaCents;
    if(input.operationId){
      const r=await q(`select accounted_cents,reserved_cents,settled_at from ai_operations where tenant_id=$1 and id=$2 for update`,[input.tenantId,input.operationId]);
      if(!r.rows.length)throw new Error("AI operation is missing; spending could not be recorded.");
      if(r.rows[0].settled_at)return;
      delta=Math.max(0,(input.targetCents??0)-Number(r.rows[0].accounted_cents));
    }
    for(const background of input.workload==="background"?[false,true]:[false])for(const w of ["daily","monthly"] as const){
      const period=periodFor(input.now,w,background);
      await q(seedSql(background,!!input.operationId),[input.tenantId,period,...periodBounds(input.now,w)]);
      await q(`update usage_counters set spent_cents=spent_cents+$3,updated_at=now() where tenant_id=$1 and period=$2`,[input.tenantId,period,delta]);
    }
    if(input.operationId)await q(`update ai_operations set accounted_cents=accounted_cents+$3 where tenant_id=$1 and id=$2`,[input.tenantId,input.operationId,delta]);
  });return {}; }catch(e){return {error:e instanceof Error?e.message:String(e)};}
}

export async function reconcileSpend(input:{
  tenantId:string;estimateCents:number;actualCents:number;action:string;searches:number;inputTokens:number;outputTokens:number;
  billedTo:"platform"|"tenant";now:Date;workload?:SpendWorkload;operationId?:string;costComplete?:boolean;costMicrousd?:number;
  resultStatus?:string;newRoles?:number;
}):Promise<{error?:string}> {
  try{await tenantTransaction(input.tenantId,async q=>{
    let accounted=input.estimateCents;
    let target=input.actualCents;
    if(input.operationId){
      const r=await q(`select accounted_cents,reserved_cents,settled_at from ai_operations where tenant_id=$1 and id=$2 for update`,[input.tenantId,input.operationId]);
      if(!r.rows.length)throw new Error("AI operation is missing; spending could not be reconciled.");
      if(r.rows[0].settled_at)return; // One durable owner: duplicate finalization has no debit or second event.
      accounted=Number(r.rows[0].accounted_cents);
      if(input.costComplete===false)target=Math.max(accounted,target+Number(r.rows[0].reserved_cents));
    }
    const delta=target-accounted;
    for(const background of input.workload==="background"?[false,true]:[false])for(const w of ["daily","monthly"] as const){
      const period=periodFor(input.now,w,background);
      await q(seedSql(background,!!input.operationId),[input.tenantId,period,...periodBounds(input.now,w)]);
      await q(`update usage_counters set spent_cents=greatest(0,spent_cents+$3),updated_at=now() where tenant_id=$1 and period=$2`,[input.tenantId,period,delta]);
    }
    if(input.operationId){
      await q(`insert into usage_events(tenant_id,action,searches,input_tokens,output_tokens,cost_cents,billed_to,occurred_at,workload,operation_id,cost_complete,cost_microusd,held_cents)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [input.tenantId,input.action,input.searches,input.inputTokens,input.outputTokens,input.actualCents,input.billedTo,input.now.toISOString(),input.workload??"foreground",input.operationId,input.costComplete!==false,input.costMicrousd??null,Math.max(0,target-input.actualCents)]);
      await q(`update ai_operations set accounted_cents=$3,known_cost_microusd=$4,cost_complete=$5,status=$6,finished_at=now(),settled_at=now(),result_status=$7,new_roles=$8 where tenant_id=$1 and id=$2`,
        [input.tenantId,input.operationId,target,input.costMicrousd??0,input.costComplete!==false,input.costComplete===false?"unknown":"complete",input.resultStatus??null,input.newRoles??null]);
    }else{
      await q(`insert into usage_events(tenant_id,action,searches,input_tokens,output_tokens,cost_cents,billed_to,occurred_at) values($1,$2,$3,$4,$5,$6,$7,$8)`,
        [input.tenantId,input.action,input.searches,input.inputTokens,input.outputTokens,input.actualCents,input.billedTo,input.now.toISOString()]);
    }
  });return {};}catch(e){return{error:e instanceof Error?e.message:String(e)};}
}

export async function readSpent(tenantId:string,now:Date,window:SpendWindow="monthly",workload?:SpendWorkload):Promise<{spentCents:number|null;error?:string}>{
  const background=workload==="background";
  const {data,error}=await rawQuery<{spent_cents:number}>(`select coalesce(
    (select spent_cents from usage_counters where tenant_id=$1 and period=$2),
    (select sum(cost_cents + held_cents) from usage_events where tenant_id=$1 and occurred_at >= $3::timestamptz and occurred_at < $4::timestamptz
      ${background?"and (workload='background' or (workload is null and action='crawl'))":""}),0)::integer as spent_cents`,
    [tenantId,periodFor(now,window,background),...periodBounds(now,window)],tenantId);
  if(error)return{spentCents:null,error:error.message};
  return{spentCents:data[0]?.spent_cents??0};
}
