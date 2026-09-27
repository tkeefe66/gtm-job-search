import { randomUUID } from "node:crypto";
import { rawQuery, tenantTransaction } from "./supabase";
import { describeWriteFailure } from "./write-failure";
import { aiAttribution, type AIAttribution } from "./ai-attribution";
import type { AIRequestMeta, Completion, ProviderId, Usage } from "./providers/types";
import { costMicrousd, pricingSnapshot } from "./providers/exact-pricing";
import { effectiveSearchMode } from "./providers/effective-search-mode";
import { reconcileSpend, type SpendWorkload } from "./usage-store";

export class AIBillingPersistenceError extends Error {
  readonly billingPersistence = true;
  constructor(message:string) { super(message); this.name="AIBillingPersistenceError"; }
}

export interface LedgerContext { tenantId:string;operationId:string;provider:ProviderId;model:string }
const safeId=(value:unknown):string|null=>typeof value==="string"&&/^[a-zA-Z0-9_.:/-]{1,200}$/.test(value)?value:null;
const failure=(error:{message:string}|null,what:string)=>{
  const message=describeWriteFailure(error?.message,what);
  if(message!==undefined)throw new AIBillingPersistenceError(message);
};
export function validUsage(usage:Usage):boolean{
  if(!usage||typeof usage!=="object")return false;
  for(const key of ["inputTokens","cachedInputTokens","outputTokens","searches"] as const){
    if(!Number.isSafeInteger(usage[key])||usage[key]<0)return false;
  }
  for(const key of ["groundedRequests","cacheWrite5mTokens","cacheWrite1hTokens"] as const){
    if(usage[key]!==undefined&&(!Number.isSafeInteger(usage[key])||usage[key]! < 0))return false;
  }
  return true;
}
export async function beginAIRequest(ctx:LedgerContext,meta:AIRequestMeta,attribution:Readonly<AIAttribution>=aiAttribution()):Promise<string>{
  const id=randomUUID();
  // Price validation occurs before dispatch and unknown outcomes retain the same rate evidence.
  const prices=JSON.stringify(pricingSnapshot(ctx.provider,ctx.model));
  try {
    await tenantTransaction(ctx.tenantId,async q=>{
      const op=await q(`select status,settled_at from ai_operations where tenant_id=$1 and id=$2 for update`,[ctx.tenantId,ctx.operationId]);
      if(!op.rows.length || op.rows[0].status!=="running" || op.rows[0].settled_at)
        throw new Error("This AI operation is no longer active. Start a new action before making another request.");
      await q(`update ai_operations set last_activity_at=now() where tenant_id=$1 and id=$2`,[ctx.tenantId,ctx.operationId]);
      await q(`insert into ai_usage_requests(id,tenant_id,operation_id,company,crawl_run_id,job_id,trigger,phase,provider,model,kind,max_tokens,max_searches,search_mode,pricing_snapshot)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)`,
        [id,ctx.tenantId,ctx.operationId,attribution.company??null,attribution.crawlRunId??null,attribution.jobId??null,attribution.trigger??null,attribution.phase??null,ctx.provider,ctx.model,meta.kind,meta.maxTokens,meta.maxSearches??null,
          meta.kind==="search"?effectiveSearchMode(ctx.provider,ctx.model,meta.searchMode):null,prices]);
    });
  } catch(error) {
    throw new AIBillingPersistenceError(describeWriteFailure(error instanceof Error?error.message:String(error),"record the AI request before starting it")!);
  }
  return id;
}
export function exactCompletionCost(ctx:Pick<LedgerContext,"provider"|"model">,completion:Completion):number{
  if(!validUsage(completion.usage))throw new Error("The provider did not report valid usage; this request's cost is unknown.");
  return costMicrousd(ctx.provider,ctx.model,completion.usage);
}
export async function finishAIRequest(ctx:LedgerContext,id:string,completion:Completion,exactCost:number):Promise<void>{
  // Pick only numeric fields: never persist arbitrary response properties.
  const u=completion.usage;
  const usage={inputTokens:u.inputTokens,cachedInputTokens:u.cachedInputTokens,outputTokens:u.outputTokens,searches:u.searches,
    groundedRequests:u.groundedRequests??0,cacheWrite5mTokens:u.cacheWrite5mTokens??0,cacheWrite1hTokens:u.cacheWrite1hTokens??0};
  const {data,error}=await rawQuery(`update ai_usage_requests set state='known',finished_at=now(),provider_request_id=$4,provider_response_id=$5,
    stop_reason=$6,usage_source=$7,usage=$8::jsonb,pricing_snapshot=$9::jsonb,cost_microusd=$10
    where tenant_id=$1 and operation_id=$2 and id=$3 and state='in_flight' returning id`,
    [ctx.tenantId,ctx.operationId,id,safeId(completion.providerRequestId),safeId(completion.providerResponseId),safeId(completion.stopReason),completion.usageSource??"provider",JSON.stringify(usage),JSON.stringify(pricingSnapshot(ctx.provider,ctx.model)),exactCost],ctx.tenantId);
  failure(error,"record completed AI usage");
  if(!data.length)throw new AIBillingPersistenceError("AI usage could not be attached to its active request. Cost remains under review.");
  const touched=await rawQuery(`update ai_operations set last_activity_at=now() where tenant_id=$1 and id=$2 and status='running'`,[ctx.tenantId,ctx.operationId],ctx.tenantId);
  failure(touched.error,"record AI operation activity");
}
export async function markAIRequestUnknown(ctx:LedgerContext,id:string,errorKind="provider_outcome_unknown",reason?:unknown):Promise<void>{
  const details=reason&&typeof reason==="object"?reason as {providerRequestId?:unknown;providerResponseId?:unknown;stopReason?:unknown}:{};
  const {error}=await rawQuery(`update ai_usage_requests set state='unknown',finished_at=now(),error_kind=$4,provider_request_id=$5,provider_response_id=$6,stop_reason=$7
    where tenant_id=$1 and operation_id=$2 and id=$3 and state='in_flight'`,[ctx.tenantId,ctx.operationId,id,safeId(errorKind),safeId(details.providerRequestId),safeId(details.providerResponseId),safeId(details.stopReason)],ctx.tenantId);
  failure(error,"record uncertain AI usage");
}

/** No provider retry: abandoned attempts become unknown and retain their recorded reservation. */
export async function recoverStaleAIOperations(tenantId:string,now=new Date()):Promise<{recovered:number;error?:string}>{
  const cutoff=new Date(now.getTime()-30*60*1000).toISOString();
  const {data,error}=await rawQuery<{id:string;action:string;workload:SpendWorkload;started_at:string;accounted_cents:number;provider:string;billed_to:"platform"|"tenant"}>(
    `update ai_operations o set status='recovering',last_activity_at=$3::timestamptz
      where o.tenant_id=$1 and o.settled_at is null and o.last_activity_at < $2::timestamptz
        and o.status in ('running','recovering')
        and not exists(select 1 from ai_usage_requests r where r.tenant_id=$1 and r.operation_id=o.id and r.state='in_flight' and r.started_at >= $2::timestamptz)
      returning id,action,workload,started_at,accounted_cents,provider,billed_to`,[tenantId,cutoff,now.toISOString()],tenantId);
  const described=describeWriteFailure(error?.message,"check interrupted AI operations");
  if(described!==undefined)return{recovered:0,error:described};
  let recovered=0;
  for(const op of data){
    const marked=await rawQuery(`update ai_usage_requests set state='unknown',finished_at=now(),error_kind='process_interrupted'
      where tenant_id=$1 and operation_id=$2 and state='in_flight'`,[tenantId,op.id],tenantId);
    const markFailure=describeWriteFailure(marked.error?.message,"record interrupted AI requests");
    if(markFailure!==undefined)return{recovered,error:markFailure};
    const sum=await rawQuery<{cost:string;searches:string;inputs:string;outputs:string}>(`select coalesce(sum(cost_microusd),0)::text cost,
      coalesce(sum((usage->>'searches')::bigint),0)::text searches,coalesce(sum((usage->>'inputTokens')::bigint),0)::text inputs,
      coalesce(sum((usage->>'outputTokens')::bigint),0)::text outputs from ai_usage_requests where tenant_id=$1 and operation_id=$2 and state='known'`,[tenantId,op.id],tenantId);
    const sumFailure=describeWriteFailure(sum.error?.message,"read recorded AI usage");
    if(sumFailure!==undefined)return{recovered,error:sumFailure};
    const s=sum.data[0];
    const settled=await reconcileSpend({tenantId,operationId:op.id,estimateCents:op.accounted_cents,actualCents:Math.ceil(Number(s.cost)/10000),
      costMicrousd:Number(s.cost),costComplete:false,action:op.action,workload:op.workload,searches:Number(s.searches),inputTokens:Number(s.inputs),outputTokens:Number(s.outputs),billedTo:op.billed_to,now:new Date(op.started_at)});
    if(settled.error!==undefined)return{recovered,error:settled.error};
    recovered++;
  }
  return{recovered};
}

export interface CompanySpendSummary {
  company:string;month:string;knownCostMicrousd:number|null;unknownRequests:number;inFlightRequests:number;
  latest:{occurredAt:string;costMicrousd:number|null;costComplete:boolean;status:string|null;newRoles:number|null}|null;
}
export async function readCompanySpendSummaries(tenantId:string,now=new Date()):Promise<{summaries:CompanySpendSummary[];error?:string}>{
  const start=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1)).toISOString();
  const end=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+1,1)).toISOString();
  const {data,error}=await rawQuery<{company:string;known_cost:string|null;unknown_n:string;flight_n:string;latest:CompanySpendSummary["latest"]}>(`
    select w.company,
      coalesce((select sum(r.cost_microusd)::text from ai_usage_requests r where r.tenant_id=$1 and r.company=w.company and r.started_at >= $2 and r.started_at < $3 and r.state='known'),
        case when exists(select 1 from ai_operations fo where fo.tenant_id=$1 and fo.company=w.company and fo.started_at >= $2 and fo.started_at < $3 and fo.cost_complete) then '0' else null end) known_cost,
      (select count(*)::text from ai_usage_requests r where r.tenant_id=$1 and r.company=w.company and r.started_at >= $2 and r.started_at < $3 and r.state='unknown') unknown_n,
      (select count(*)::text from ai_usage_requests r where r.tenant_id=$1 and r.company=w.company and r.started_at >= $2 and r.started_at < $3 and r.state='in_flight') flight_n,
      (select jsonb_build_object('occurredAt',o.started_at,'costMicrousd',
        case when o.cost_complete or o.known_cost_microusd > 0
          or exists(select 1 from ai_usage_requests kr where kr.tenant_id=$1 and kr.operation_id=o.id and kr.state='known')
        then greatest(o.known_cost_microusd,coalesce((select sum(kr.cost_microusd)
          from ai_usage_requests kr where kr.tenant_id=$1 and kr.operation_id=o.id and kr.state='known'),0))
        else null end,
        'costComplete',o.cost_complete,'status',o.result_status,'newRoles',o.new_roles)
       from ai_operations o where o.tenant_id=$1 and o.company=w.company order by o.started_at desc limit 1) latest
    from watchlist w where w.tenant_id=$1`,[tenantId,start,end],tenantId);
  const described=describeWriteFailure(error?.message,"load company spending");
  if(described!==undefined)return{summaries:[],error:described};
  return{summaries:data.map(r=>({company:r.company,month:start.slice(0,7),knownCostMicrousd:r.known_cost===null?null:Number(r.known_cost),unknownRequests:Number(r.unknown_n),inFlightRequests:Number(r.flight_n),latest:r.latest}))};
}
