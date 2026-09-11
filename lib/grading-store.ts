import { rawQuery } from "./supabase";
import { resolveTenantId } from "./tenant";
import { FINISH_GRADE_SQL, retryDelayMinutes, type GradingFailure } from "./grading-policy";
import type { Job } from "./types";

export async function gradingPaused(): Promise<string | null> {
  const tenant = await resolveTenantId();
  const { data, error } = await rawQuery<{value:string}>(
    "select value from app_settings where tenant_id=$1 and key='grading_pause'", [tenant], tenant);
  if (error) throw new Error("Could not check grading recovery. Try again shortly.");
  if (!data.length) return null;
  return typeof data[0].value === "string" && data[0].value
    ? data[0].value : "Grading is paused. Check your provider settings, then retry missing grades.";
}

export async function recordGradeFailure(id: string, lease: string, attempt: number, failure: GradingFailure) {
  const tenant = await resolveTenantId();
  const message = failure.kind === "transient" && attempt >= 5
    ? "Grading failed after five attempts. Retry missing grades to try again." : failure.message;
  const { error } = await rawQuery(`with failed as (
    update jobs set grading_state='failed', grading_error=$4, grading_lease=null,
      grading_next_at=now()+($5 * interval '1 minute')
    where tenant_id=$1 and id=$2 and grading_lease=$3 and fit_score is null returning id
  ) insert into app_settings(tenant_id,key,value)
    select $1,'grading_pause',to_jsonb($4::text) where $6::boolean and exists(select 1 from failed)
    on conflict(tenant_id,key) do update set value=excluded.value`,
    [tenant,id,lease,message,retryDelayMinutes(attempt),failure.kind === "blocked"], tenant);
  if (error) throw new Error("Could not save the grading failure. Recovery will retry after the current lease expires.");
  console.warn(`grading: ${failure.kind} failure recorded; attempt ${attempt}`);
}

export async function updateMissingGrade(id: string, patch: Partial<Job>, lease: string, terminal: string[]) {
  const tenant = await resolveTenantId();
  const { data, error } = await rawQuery(FINISH_GRADE_SQL,
    [tenant,id,lease,patch.fit_score,patch.status ?? null,terminal,patch.fit_summary ?? null], tenant);
  if (error) return { error: "Could not save the grade. Recovery will retry after the current lease expires." };
  return { saved: data.length > 0 };
}
