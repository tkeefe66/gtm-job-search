import { tenantTransaction, rawQuery, describeThrown } from "@/lib/supabase";
import { resolveTenantId } from "@/lib/tenant";
import { acceptJob } from "@/lib/job-acceptance";
import type { JobInsert } from "@/lib/types";
import type { Job } from "@/lib/types";
import type { SourceRecord } from "@/lib/job-dispositions";

/** Internal only: RPC actions choose the actor, never the browser payload. */
export async function patchJobWithActor(tenantId: string, id: string, patch: Partial<Job>, actor: "user" | "automation", explicitDisposition = false): Promise<{error?: string}> {
  try {
    return await tenantTransaction(tenantId, async query => {
      await query("select set_config('app.disposition_actor',$1,true)", [actor]);
      if (explicitDisposition) await query("select set_config('app.explicit_disposition','true',true)");
      const payload: Record<string, unknown> = { ...patch, updated_at: new Date().toISOString() };
      delete payload.id; delete payload.tenant_id; delete payload.created_at;
      const keys = Object.keys(payload).filter(key => payload[key] !== undefined);
      const values = keys.map(key => payload[key] !== null && typeof payload[key] === "object" ? JSON.stringify(payload[key]) : payload[key]);
      const set = keys.map((key,i) => '"' + key.replace(/"/g,'""') + '"=$' + (i+3)).join(',');
      const { rows } = await query(`update jobs set ${set} where tenant_id=$1 and id=$2 returning id`, [tenantId,id,...values]);
      return rows.length ? {} : { error: "Could not update this role because it is no longer available. Refresh Roles and try again." };
    });
  } catch (cause) {
    const error = describeThrown(cause);
    console.error("job disposition: update failed", error);
    return { error: error.message };
  }
}

export async function updateAutomaticJob(id: string, patch: Partial<Job>): Promise<{error?:string}> {
  return patchJobWithActor(await resolveTenantId(), id, patch, "automation");
}

export async function readSourceQuality(tenantId: string): Promise<{startedAt:string; records:SourceRecord[]; error?:string}> {
  const {data,error} = await rawQuery<{started_at:Date|string; records:SourceRecord[]}>(SOURCE_QUALITY_SQL, [tenantId], tenantId);
  if (error) return {startedAt:"",records:[],error:error.message};
  if (!data[0]) return {startedAt:"",records:[],error:"Source tracking has not been initialized. Apply the job dispositions migration and retry."};
  return {startedAt:new Date(data[0].started_at).toISOString(), records:data[0].records};
}

/** Internal ingestion context distinguishes a manually chosen URL from search results. */
export async function addIngestedJob(job: JobInsert, chosenByUser = false): Promise<{job?:Job; inserted?:boolean; error?:string}> {
  try { return await acceptJob(await resolveTenantId(),job,chosenByUser ? "user" : "automation"); }
  catch (cause) {
    const error=describeThrown(cause);
    console.error("job disposition: automatic acceptance failed",error);
    return {error:error.message};
  }
}

export const SOURCE_QUALITY_SQL = `
    select started_at, coalesce((select jsonb_agg(r order by discovered_at desc) from (
      select s.id,s.job_id,s.company,s.role_title,s.source_url,s.source_method,s.discovered_at,s.cohort,s.never_live,
        e.status,e.disposition,e.disposition_reason,e.actor,e.occurred_at,
        (select count(*)::int from job_disposition_events n where n.tenant_id=$1 and n.source_record_id=s.id) as event_count
      from job_source_records s
      join lateral (select * from job_disposition_events x where x.tenant_id=$1 and x.source_record_id=s.id order by id desc limit 1) e on true
      where s.tenant_id=$1
    ) r),'[]'::jsonb) as records from source_quality_launch where singleton`;
