import { rawQuery } from "./supabase";
import { describeWriteFailure } from "./write-failure";
import { readPaidSearchAvailability } from "./metered";
import { deepSearchAdvice, type CompanySearchEvidence, type DeepSearchAdvice } from "./deep-search-advice";

/** Skipped direct checks never count as search attempts. Older completed search
 * runs remain visible with unrecorded cost; request-linked runs carry measured cost. */
export async function readCompanySearchEvidence(tenantId: string, company?: string): Promise<{ evidence: CompanySearchEvidence[]; error?: string }> {
  const { data, error } = await rawQuery<CompanySearchEvidence>(`
    select w.company, w.model_retry_after as "modelRetryAfter", w.source_revision as "sourceRevision",
      (select jsonb_build_object('method', c.method, 'status', c.status, 'startedAt', c.started_at)
       from crawl_runs c where c.tenant_id=$1 and c.company=w.company and c.source_revision=w.source_revision order by c.started_at desc limit 1) as "latestCheck",
      coalesce((select jsonb_agg(history.item order by history.started_at desc) from (
        select c.started_at, jsonb_build_object(
          'id', c.id, 'startedAt', c.started_at, 'finishedAt', c.finished_at, 'status', c.status,
          'sourceUrl', c.source_url, 'sourceRevision', c.source_revision,
          'previousSource', c.source_revision <> w.source_revision,
          'rolesFound', c.roles_found, 'newRoles', c.new_roles, 'error', c.error,
          'costStatus', case
            when not exists(select 1 from ai_usage_requests r where r.tenant_id=$1 and r.crawl_run_id=c.id and r.company=w.company) then 'unrecorded'
            when exists(select 1 from ai_usage_requests r where r.tenant_id=$1 and r.crawl_run_id=c.id and r.company=w.company and r.state='unknown') then 'unknown'
            when c.finished_at is null or exists(select 1 from ai_usage_requests r where r.tenant_id=$1 and r.crawl_run_id=c.id and r.company=w.company and r.state='in_flight') then 'running'
            else 'complete' end,
          'costMicrousd', (select sum(r.cost_microusd) from ai_usage_requests r
            where r.tenant_id=$1 and r.crawl_run_id=c.id and r.company=w.company and r.state='known'),
          'costComplete', c.finished_at is not null and exists(select 1 from ai_usage_requests r where r.tenant_id=$1 and r.crawl_run_id=c.id and r.company=w.company)
            and not exists(select 1 from ai_usage_requests r where r.tenant_id=$1 and r.crawl_run_id=c.id and r.company=w.company and r.state<>'known')
        ) item from crawl_runs c where c.tenant_id=$1 and c.company=w.company
          and (exists(select 1 from ai_usage_requests r where r.tenant_id=$1 and r.crawl_run_id=c.id and r.company=w.company and r.kind='search')
            or (c.method='search' and c.finished_at is not null and c.status in ('ok','partial','empty','unchanged','error')))
        order by c.started_at desc limit 3
      ) history), '[]'::jsonb) as attempts
    from watchlist w where w.tenant_id=$1 and ($2::text is null or w.company=$2)
  `, [tenantId, company ?? null], tenantId);
  const failure = describeWriteFailure(error?.message, "load previous company searches");
  if (failure !== undefined) return { evidence: [], error: failure };
  return { evidence: data };
}

export async function loadDeepSearchAdvice(tenantId: string, isAdmin: boolean, company?: string): Promise<{ advice: DeepSearchAdvice[]; error?: string }> {
  const [history, availability] = await Promise.all([
    readCompanySearchEvidence(tenantId, company), readPaidSearchAvailability(tenantId, isAdmin),
  ]);
  if (history.error !== undefined) return { advice: [], error: history.error };
  if (availability.error !== undefined) return { advice: [], error: availability.error };
  return { advice: history.evidence.map(item => deepSearchAdvice(item, availability)) };
}
