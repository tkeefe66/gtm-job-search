import { rawQuery } from "./supabase";
import { describeWriteFailure } from "./write-failure";
import type { CrawlStatus } from "./types";

export type CrawlTrigger = "automatic" | "check" | "deep";
export const COMPANY_SEARCH_LIMIT = 5;
export type ModelAttempt = "none" | "success" | "failure";

export function paidSearchDecision(input: { trigger: CrawlTrigger; allowPaidSearch: boolean; modelRetryAfter: string | null; now?: Date }): { allowed: boolean; reason?: string } {
  if (input.trigger === "deep") return { allowed: true };
  if (input.trigger === "check") return { allowed: false, reason: "Direct check finished. Choose Deep search to search beyond direct sources." };
  if (!input.allowPaidSearch) return { allowed: false, reason: "Paid search is off. Add a careers URL or choose Deep search." };
  if (input.modelRetryAfter && Date.parse(input.modelRetryAfter) > (input.now ?? new Date()).getTime()) {
    return { allowed: false, reason: `Paid search is paused after repeated model failures until ${input.modelRetryAfter.slice(0, 10)}. Direct checks remain available.` };
  }
  return { allowed: true };
}

export function modelBackoff(failures: number, retryAfter: string | null, attempt: ModelAttempt, now: Date): { failures: number; retryAfter: string | null } {
  if (attempt === "none") return { failures, retryAfter };
  if (attempt === "success") return { failures: 0, retryAfter: null };
  const next = failures + 1;
  const days = next < 2 ? 0 : next === 2 ? 7 : next === 3 ? 14 : 30;
  return { failures: next, retryAfter: days ? new Date(now.getTime() + days * 86400000).toISOString() : null };
}

/** Model backoff never blocks direct collection and never changes page-health evidence. */
export async function crawlPolicyOutcome(tenantId: string, company: string, input: {
  trigger: CrawlTrigger; modelAttempt: ModelAttempt; status: CrawlStatus; now?: Date; sourceRevision?: number;
}): Promise<{ error?: string }> {
  const now = input.now ?? new Date();
  const successful = input.status === "ok" || input.status === "empty" || input.status === "unchanged";
  const { error } = await rawQuery(`update watchlist set
    last_attempted_at = $3::timestamptz,
    last_successful_check_at = case when $4 then $3::timestamptz else last_successful_check_at end,
    next_attempt_at = $3::timestamptz + (crawl_interval_days || ' days')::interval,
    consecutive_model_failures = case $5 when 'success' then 0 when 'failure' then consecutive_model_failures + 1 else consecutive_model_failures end,
    model_retry_after = case $5 when 'success' then null when 'failure' then
      case when consecutive_model_failures + 1 < 2 then null
           when consecutive_model_failures + 1 = 2 then $3::timestamptz + interval '7 days'
           when consecutive_model_failures + 1 = 3 then $3::timestamptz + interval '14 days'
           else $3::timestamptz + interval '30 days' end else model_retry_after end
    where tenant_id = $1 and company = $2 and ($6::integer is null or source_revision=$6)`, [tenantId, company, now.toISOString(), successful, input.modelAttempt, input.sourceRevision ?? null], tenantId);
  return { error: describeWriteFailure(error?.message, "record the company's next check") };
}
