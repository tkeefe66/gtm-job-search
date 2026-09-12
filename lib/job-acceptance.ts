import { tenantTransaction } from "@/lib/supabase";
import { NORMALIZED_COMPANY_SQL, normalizeCompanyName, normalizeRoleKey } from "@/lib/role-key";
import type { Job, JobInsert } from "@/lib/types";

/**
 * Every app job insert goes through this acceptance boundary. Serialize only
 * the short database operation, per tenant, then read a fresh READ COMMITTED
 * snapshot AFTER obtaining the lock. No posting/model calls belong here.
 *
 * Title identity retains the existing case/whitespace company+title rule.
 * Exact posting/source URLs also connect employer spelling and relink aliases.
 * We intentionally do not strip query parameters (they can identify a job),
 * or use the loose companyIdentityKey intended only for display grouping.
 * Existing duplicates are retained unchanged; oldest matching row wins. This
 * works on legacy databases without deleting user notes or terminal statuses.
 */
export async function acceptJob(tenantId: string, job: JobInsert): Promise<{ job: Job; inserted: boolean }> {
  return tenantTransaction(tenantId, async (query) => {
    await query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`job-acceptance:${tenantId}`]);
    const urls = [job.job_url, job.source_url].filter((url): url is string => !!url);
    const { rows } = await query(
      `select * from jobs where tenant_id = $1 and
        (${NORMALIZED_COMPANY_SQL} = $2 or job_url = any($3::text[]) or source_url = any($3::text[]))
        order by created_at asc, id asc`,
      [tenantId, normalizeCompanyName(job.company), urls]
    );
    const key = normalizeRoleKey(job.company, job.role_title);
    const existing = (rows as unknown as Job[]).find(row =>
      normalizeRoleKey(row.company, row.role_title) === key ||
      (!!row.job_url && urls.includes(row.job_url)) ||
      (!!row.source_url && urls.includes(row.source_url))
    );
    if (existing) return { job: existing, inserted: false };

    // Force the authenticated tenant even if an RPC caller supplies extra keys.
    const payload: Record<string, unknown> = { ...job, tenant_id: tenantId };
    const columns = Object.keys(payload).filter(key => payload[key] !== undefined);
    const values = columns.map(key => {
      const value = payload[key];
      return value !== null && typeof value === "object" ? JSON.stringify(value) : value;
    });
    const quoted = columns.map(key => '"' + key.replace(/"/g, '""') + '"');
    const result = await query(
      `insert into jobs (${quoted.join(", ")}) values (${values.map((_, i) => `$${i + 1}`).join(", ")}) returning *`,
      values
    );
    return { job: result.rows[0] as unknown as Job, inserted: true };
  });
}
