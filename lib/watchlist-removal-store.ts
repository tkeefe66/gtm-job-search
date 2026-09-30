import {rawQuery} from "./supabase";
import {normalizeCompanyName} from "./role-key";
import {describeWriteFailure} from "./write-failure";

export async function readSuppressedCompanyKeys(tenantId: string): Promise<{keys: Set<string>; error?: string}> {
  const {data, error} = await rawQuery<{company: string}>(`select company from watchlist
    where tenant_id=$1 and tracking_enabled=false and removal_reason='not_interested'`, [tenantId], tenantId);
  const failure = describeWriteFailure(error?.message, "read removed companies");
  return {keys: new Set(failure === undefined ? data.map(row => normalizeCompanyName(row.company)) : []), error: failure};
}
