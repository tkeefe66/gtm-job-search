import {rawQuery} from "./supabase";
import {companyIdentityKey, NORMALIZED_COMPANY_SQL, normalizeCompanyName, normalizeTitle} from "./role-key";
import type {Role} from "./types";
import {CRAWL_PARSER_VERSION, type CrawlSnapshot} from "./crawl-snapshot";
import {describeWriteFailure} from "./write-failure";

export async function readCrawlSnapshot(tenantId:string, company:string, sourceKey?:string, criteriaHash?:string):Promise<CrawlSnapshot|null> {
  const {data,error} = await rawQuery<CrawlSnapshot>(`select source_key as "sourceKey", criteria_fingerprint as "criteriaHash",
    content_fingerprint as "contentHash", listings, processed, captured_at as "capturedAt"
    from company_crawl_snapshots where tenant_id=$1 and company_key=$2 and ($3::text is null or source_key=$3)
    and ($4::text is null or criteria_fingerprint=$4) and parser_version=$5
    order by captured_at desc limit 1`, [tenantId,companyIdentityKey(company),sourceKey??null,criteriaHash??null,CRAWL_PARSER_VERSION], tenantId);
  const failure = describeWriteFailure(error?.message,"read the company's source snapshot");
  if (failure !== undefined) throw new Error(failure);
  const snapshot = data[0];
  if (!snapshot || !Array.isArray(snapshot.listings) || !snapshot.processed || typeof snapshot.processed !== "object") return null;
  return snapshot;
}

/** Only durable completed/intentional outcomes acknowledge processing. */
export async function settledCrawlRoles(tenantId:string,company:string,roles:Role[]):Promise<Role[]> {
  const {data,error}=await rawQuery<{role_title:string;job_url:string|null;fit_score:number|null;posting:{enrichedAt?:unknown}|null;source:string;status:string;grading_chosen:boolean;never_live:boolean}>(
    `select role_title,job_url,fit_score,posting,source,status,grading_chosen,never_live from jobs
      where tenant_id=$1 and ${NORMALIZED_COMPANY_SQL}=$2`,[tenantId,normalizeCompanyName(company)],tenantId);
  const failure=describeWriteFailure(error?.message,"verify stored crawl listings");
  if(failure!==undefined) throw new Error(failure);
  return roles.filter(role=>data.some(row=>(row.job_url===role.job_url || normalizeTitle(row.role_title)===normalizeTitle(role.role_title)) &&
    ((row.fit_score!==null&&typeof row.posting?.enrichedAt==="string"&&row.posting.enrichedAt!=="") ||
      row.status!=="New" || row.source!=="Crawl" || row.grading_chosen || row.never_live)));
}

export async function saveCrawlSnapshot(tenantId:string,company:string,snapshot:CrawlSnapshot):Promise<void> {
  const {error} = await rawQuery(`insert into company_crawl_snapshots
    (tenant_id,company_key,source_key,criteria_fingerprint,parser_version,content_fingerprint,listings,processed,captured_at)
    values($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)
    on conflict(tenant_id,company_key,source_key,criteria_fingerprint,parser_version) do update set
      content_fingerprint=excluded.content_fingerprint,listings=excluded.listings,
      processed=excluded.processed,captured_at=excluded.captured_at
    where company_crawl_snapshots.captured_at <= excluded.captured_at`,
    [tenantId,companyIdentityKey(company),snapshot.sourceKey,snapshot.criteriaHash,CRAWL_PARSER_VERSION,snapshot.contentHash,
      JSON.stringify(snapshot.listings),JSON.stringify(snapshot.processed),snapshot.capturedAt],tenantId);
  const failure=describeWriteFailure(error?.message,"save the company's source snapshot");
  if(failure!==undefined) throw new Error(failure);
}
