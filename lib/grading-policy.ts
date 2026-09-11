export type GradingFailure = { kind: "blocked" | "transient"; message: string };

/** Classify vendor failures, but never persist or display raw SDK text. */
export function gradingFailure(error: unknown): GradingFailure {
  const value = error as { status?: number; message?: string; billingBlocked?:boolean } | null;
  const message = typeof value?.message === "string" ? value.message : "";
  if (value?.billingBlocked || /credit balance|insufficient.*credit/i.test(message)) {
    return { kind: "blocked", message: "Grading paused: add API credits with your provider, then retry missing grades." };
  }
  if ([400, 401, 403, 404].includes(value?.status ?? 0)) {
    return { kind: "blocked", message: "Grading paused: check your API key in Settings, then retry missing grades." };
  }
  return { kind: "transient", message: "Grading failed temporarily. It will retry automatically." };
}

export function retryDelayMinutes(attempt: number): number {
  return [5, 30, 120, 360, 1440][Math.min(4, Math.max(0, attempt - 1))];
}

// A single atomic claim. No external request holds a database transaction open.
// An abandoned lease becomes eligible again; attempts bound even crash retries.
export const CLAIM_GRADE_SQL = `with candidate as (
  select id from jobs where tenant_id = $1 and fit_score is null
    and status <> all($2::text[]) and status <> 'Posting Closed' and not never_live
    and grading_attempts < 5 and (grading_next_at is null or grading_next_at <= now())
    and not exists (select 1 from app_settings where tenant_id=$1 and key='grading_pause')
  order by created_at, id for update skip locked limit 1
) update jobs j set grading_state='running', grading_attempts=grading_attempts+1,
  grading_lease=$3, grading_next_at=now()+interval '30 minutes'
  from candidate c where j.id=c.id and j.tenant_id=$1 returning j.*`;

// Re-check mutable facts after the model returns. A manually entered grade, a
// newly closed row, or a newer lease always wins over this in-flight request.
export const FINISH_GRADE_SQL = `update jobs set fit_score=$4, fit_summary=coalesce($7::text,fit_summary),
  status=case when status='New' and not grading_chosen and $5::text is not null then $5 else status end,
  grading_state='graded', grading_error=null, grading_next_at=null, grading_lease=null, updated_at=now()
  where tenant_id=$1 and id=$2 and grading_lease=$3 and fit_score is null
    and status <> all($6::text[]) and status <> 'Posting Closed' and not never_live returning id`;
