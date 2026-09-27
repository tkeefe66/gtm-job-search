import { randomUUID } from "node:crypto";
import { rawQuery } from "@/lib/supabase";
import { describeWriteFailure } from "@/lib/write-failure";
import { open } from "@/lib/secret-box";
import { resolveTenantId } from "@/lib/tenant";
import { runWithBilling, billingScope, recordUsage, type BillingScope } from "@/lib/billing-context";
import { reserveSpend, reconcileSpend, readSpent, advanceSpend, type SpendWorkload } from "@/lib/usage-store";
import { cappedMessage, needsKeyMessage, resetsOn, resolveTier, type Tier } from "@/lib/budget";
import { readSpendLimits, readBackgroundSpendLimits } from "@/lib/spend-limit-store";
import { providerFor } from "@/lib/providers/registry";
import { resolveProviderConfig, type ProviderConfig } from "@/lib/providers/resolution";
import type { Completion } from "@/lib/providers/types";
import { SearchUnavailableError, SpendLimitReachedError } from "@/lib/model-call";
import { aiAttribution } from "./ai-attribution";
import { AIBillingPersistenceError, beginAIRequest, finishAIRequest, markAIRequestUnknown, exactCompletionCost, recoverStaleAIOperations } from "./ai-ledger";

export interface MeteredResult<T> { result?: T; capped?: string; error?: string }
interface BudgetOptions<T> {
  action: string; estimateCents: number; isAdmin: boolean; fn: () => Promise<T>;
  workload?: SpendWorkload; allowFreeWork?: boolean;
}
function limitMessage(tier: Tier, scope: "overall"|"background", reason:"daily"|"monthly", ceiling:number, now:Date):string {
  return scope === "background"
    ? `Paid background work is paused by the $${(ceiling/100).toFixed(2)} ${reason} background allowance. Change it in Settings or wait until ${resetsOn(reason,now)} (UTC). Direct checks remain available.`
    : cappedMessage({tier,reason,ceilingCents:ceiling,resetsOn:resetsOn(reason,now)});
}

export async function withBudget<T>(opts: BudgetOptions<T>): Promise<MeteredResult<T>> {
  if(billingScope()!==null)return{result:await opts.fn()};
  const tenantId=await resolveTenantId(),now=new Date();
  const lookup=await loadTenantKey(tenantId);
  if(!lookup.ok)return{error:lookup.error};
  const ownKey=lookup.key;
  const tier=resolveTier({isAdmin:opts.isAdmin,hasOwnKey:ownKey!==null});
  if(tier==="none"&&!opts.allowFreeWork)return{capped:needsKeyMessage()};
  const overall=await readSpendLimits(tenantId,tier==="admin");
  if(overall.error!==undefined)return{error:overall.error};
  const background=opts.workload==="background"?await readBackgroundSpendLimits(tenantId):undefined;
  if(background?.error!==undefined)return{error:background.error};
  const stale=await recoverStaleAIOperations(tenantId,now);
  if(stale.error!==undefined)return{error:stale.error};
  const config=ownKey?.config??resolveProviderConfig(null)!;
  const operationId=randomUUID();
  const workload=opts.workload??"foreground";
  const billedTo: "platform"|"tenant" = tier==="byo"?"tenant":"platform";
  const operation={billedTo,id:operationId,action:opts.action,workload,provider:config.providerId,model:config.model,attribution:aiAttribution()};
  const estimate=Math.max(1,opts.estimateCents);
  let denied=tier==="none"?needsKeyMessage():undefined;
  let initialAvailable=Infinity;
  for(const group of [{limits:overall.limits,background:false},...(background?[{limits:background.limits!,background:true}]:[])]) {
    for(const window of ["daily","monthly"] as const) {
      const ceiling=window==="daily"?group.limits.dailyCents:group.limits.monthlyCents;
      if(ceiling===null)continue;
      const spent=await readSpent(tenantId,now,window,group.background?"background":undefined);
      const failure=describeWriteFailure(spent.error,"load your spending");
      if(failure!==undefined)return{error:failure};
      initialAvailable=Math.min(initialAvailable,ceiling-spent.spentCents!);
      if(spent.spentCents!>=ceiling||spent.spentCents!+estimate>ceiling)
        denied??=limitMessage(tier,group.background?"background":"overall",window,ceiling,now);
    }
  }
  let reserved=denied===undefined?await reserveSpend({tenantId,estimateCents:estimate,
    dailyCeilingCents:overall.limits.dailyCents,monthlyCeilingCents:overall.limits.monthlyCents,
    backgroundLimits:background?.limits,operation,now}):{ok:false,spentCents:0};
  if(reserved.error!==undefined)return{error:reserved.error};
  if(!reserved.ok){
    const reason=reserved.reason??"daily",scope=reserved.scope??"overall";
    const limits=scope==="background"?background!.limits!:overall.limits;
    denied??=limitMessage(tier,scope,reason,(reason==="daily"?limits.dailyCents:limits.monthlyCents)??0,now);
    if(!opts.allowFreeWork)return{capped:denied};
    // Free collection receives a real scope with no admission to dispatch a model.
    // Zero reservation is safe because routing must refuse every paid request.
    reserved=await reserveSpend({tenantId,estimateCents:0,dailyCeilingCents:null,monthlyCeilingCents:null,
      ...(workload==="background"?{backgroundLimits:{dailyCents:null,monthlyCents:null}}:{}),operation,now});
    if(reserved.error!==undefined)return{error:reserved.error};
    if(!reserved.ok)return{error:"Could not establish the direct-check accounting scope. Try again."};
  }
  return runScope(tier,opts,tenantId,now,reserved.spentCents,ownKey?.apiKey??null,config,operationId,denied,reserved.availableCents??initialAvailable);
}

interface TenantKey {
  apiKey: string;
  config: ProviderConfig;
}

/**
 * This tenant's key AND how to route it — or "no usable key", or "could not
 * ask". The third case is a separate arm ON PURPOSE.
 *
 * `key: null` covers four cases that are all "no usable key": nothing stored, a
 * row that will not open (tampered, moved between tenants, or written under an
 * encryption key that no longer exists), a key marked failed, and a stored
 * provider this build has no adapter for. None of them may silently fall back
 * to the platform key or to Anthropic — either would bill somebody who believes
 * they are paying their own vendor, which is the failure this whole tier is
 * meant to make impossible.
 *
 * A FAILED READ is none of those. An unreachable database returns `data: []`
 * with an error whose message is the EMPTY STRING (pg's AggregateError — see
 * lib/write-failure.ts), so discarding the error made a dead database
 * indistinguishable from a tenant who never stored a key, and printed "add your
 * API key" at them while Postgres was down.
 */
type KeyLookup = { ok: true; key: TenantKey | null } | { ok: false; error: string };

async function loadTenantKey(tenantId: string): Promise<KeyLookup> {
  const { data, error } = await rawQuery<{
    key_id: string;
    aad_version: number;
    ciphertext: string;
    nonce: string;
    auth_tag: string;
    provider: string;
    model: string | null;
  }>(
    `select key_id, aad_version, ciphertext, nonce, auth_tag, provider, model
       from tenant_api_keys where tenant_id = $1 and status = 'ok'`,
    [tenantId],
    tenantId
  );

  // The reader idiom: describeWriteFailure, then branch on !== undefined. The
  // transport hands back an object-or-null whose MESSAGE may be empty, and it
  // is the message that gets shown, so the description is substituted here.
  const described = describeWriteFailure(
    error === null ? undefined : error.message,
    "load your API key"
  );
  if (described !== undefined) {
    console.error(`metered: could not read the tenant's stored API key — ${error?.message || "(no message)"}`);
    return { ok: false, error: described };
  }

  if (data.length === 0) return { ok: true, key: null };
  const row = data[0];

  const config = resolveProviderConfig({ provider: row.provider, model: row.model });
  if (config === null) {
    console.error(`metered: a stored API key names a provider this build cannot route: ${row.provider}`);
    return { ok: true, key: null };
  }

  const plain = open(
    {
      keyId: row.key_id,
      aadVersion: row.aad_version,
      ciphertext: row.ciphertext,
      nonce: row.nonce,
      authTag: row.auth_tag,
    },
    { tenantId, provider: row.provider, model: row.model }
  );
  if (plain === null) {
    // Loud, because this is not a normal state: the row exists and cannot be
    // opened, which means tampering, a moved row, or a rotated encryption key.
    console.error(`metered: a stored API key for a tenant could not be opened`);
    return { ok: true, key: null };
  }
  return { ok: true, key: { apiKey: plain, config } };
}

async function runScope<T>(tier:Tier,opts:BudgetOptions<T>,tenantId:string,now:Date,reservedCents:number,ownKey:string|null,
  config:ProviderConfig,operationId:string,denied?:string,initialAvailable=Infinity):Promise<MeteredResult<T>> {
  const provider=providerFor(config.providerId),workload=opts.workload??"foreground";
  let accountedCents=reservedCents,exactCost=0,unknown=false;
  let pendingFlush=Promise.resolve();
  const pendingCalls=new Set<Promise<Completion>>();
  const ledger={tenantId,operationId,provider:config.providerId,model:config.model};
  // Compatible aggregate pricing is retained for legacy callers that record usage directly.
  const actualCost=()=>Math.max(Math.ceil(exactCost/10000),provider.costCents({
    inputTokens:scope.inputTokens,cachedInputTokens:scope.cachedInputTokens,outputTokens:scope.outputTokens,
    searches:scope.searches,groundedRequests:scope.groundedRequests??0,
    cacheWrite5mTokens:scope.cacheWrite5mTokens??0,cacheWrite1hTokens:scope.cacheWrite1hTokens??0},scope.model));
  const scope:BillingScope={
    tenantId,action:opts.action,workload,operationId,maxSearches:denied?0:initialAvailable===Infinity?null:Math.max(0,Math.floor(initialAvailable/Math.max(1,provider.costCents({inputTokens:0,cachedInputTokens:0,outputTokens:0,searches:1,groundedRequests:1},config.model)))),
    ...(denied?{availableCents:0,limitMessage:denied}:{}),
    flushUsage:()=>{
      pendingFlush=pendingFlush.then(async()=>{
        const actual=actualCost();
        if(actual<=accountedCents)return;
        const result=await advanceSpend({tenantId,deltaCents:actual-accountedCents,targetCents:actual,operationId,workload,now});
        const failure=describeWriteFailure(result.error,"record completed AI spending");
        if(failure!==undefined)throw new AIBillingPersistenceError(failure);
        accountedCents=actual;
      });return pendingFlush;
    },
    refreshAllowance:async()=>{
      if(denied!==undefined)return{availableCents:0,maxSearches:0,limitMessage:denied};
      const ownAccountedCents=accountedCents;
      const current=await readSpendLimits(tenantId,tier==="admin");
      if(current.error!==undefined)throw new AIBillingPersistenceError(current.error);
      const bg=workload==="background"?await readBackgroundSpendLimits(tenantId):undefined;
      if(bg?.error!==undefined)throw new AIBillingPersistenceError(bg.error);
      let availableCents=Infinity,message="";
      for(const group of [{limits:current.limits,background:false},...(bg?[{limits:bg.limits!,background:true}]:[])]){
        for(const window of ["daily","monthly"] as const){
          const cap=window==="daily"?group.limits.dailyCents:group.limits.monthlyCents;
          if(cap===null)continue;
          const read=await readSpent(tenantId,now,window,group.background?"background":undefined);
          const failure=describeWriteFailure(read.error,"check your remaining spending allowance");
          if(failure!==undefined)throw new AIBillingPersistenceError(failure);
          const remaining=cap-read.spentCents!+ownAccountedCents;
          if(remaining<availableCents){availableCents=remaining;message=limitMessage(tier,group.background?"background":"overall",window,cap,now);}
        }
      }
      const searchPrice=provider.costCents({inputTokens:0,cachedInputTokens:0,outputTokens:0,searches:1,groundedRequests:1},config.model);
      return{availableCents,maxSearches:availableCents===Infinity?null:searchPrice>0?Math.max(0,Math.floor(availableCents/searchPrice)):0,limitMessage:message};
    },
    trackCall:(meta,fn)=>{
      // Capture before the first await: sibling company/phase contexts cannot overwrite it.
      const attribution=aiAttribution();
      const call=(async()=>{
        const requestId=await beginAIRequest(ledger,meta,attribution);
        let responsePersisted=false;
        try{
          const completion=await fn();
          const cost=exactCompletionCost(ledger,completion);
          // Usage precedes persistence/validation: a malformed output still incurred this cost.
          recordUsage(completion.usage);exactCost+=cost;
          await finishAIRequest(ledger,requestId,completion,cost);
          responsePersisted=true;
          await scope.flushUsage!();
          return completion;
        }catch(error){
          if(!responsePersisted)unknown=true;
          try{if(!responsePersisted)await markAIRequestUnknown(ledger,requestId,"provider_outcome_unknown",error);}catch(recordError){console.error("ai-ledger: could not persist unknown request outcome",recordError);}
          throw error;
        }
      })();
      pendingCalls.add(call);
      void call.then(()=>pendingCalls.delete(call),()=>pendingCalls.delete(call));
      return call;
    },
    apiKey:ownKey??(tier==="admin"?process.env.ANTHROPIC_API_KEY||"":""),provider:config.providerId,model:config.model,
    searches:0,inputTokens:0,cachedInputTokens:0,outputTokens:0,cacheWrite5mTokens:0,cacheWrite1hTokens:0,
  };
  let result:T|undefined;
  try{
    result=await runWithBilling(scope,opts.fn);
    return{result};
  }catch(error){
    if(error instanceof SearchUnavailableError||error instanceof SpendLimitReachedError)return{capped:error.message};
    throw error;
  }finally{
    while(pendingCalls.size)await Promise.allSettled(Array.from(pendingCalls));
    await pendingFlush.catch(()=>{});
    const actual=actualCost();
    const outcome=result&&typeof result==="object"?result as {status?:string;newRoles?:number}:undefined;
    const reconciled=await reconcileSpend({tenantId,estimateCents:accountedCents,actualCents:actual,action:opts.action,
      searches:scope.searches,inputTokens:scope.inputTokens,outputTokens:scope.outputTokens,billedTo:tier==="byo"?"tenant":"platform",now,
      workload,operationId,costMicrousd:exactCost,costComplete:!unknown,resultStatus:outcome?.status,newRoles:outcome?.newRoles});
    if(reconciled.error!==undefined)throw new AIBillingPersistenceError(describeWriteFailure(reconciled.error,"record AI spending")!);
  }
}
