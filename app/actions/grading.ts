"use server";

import { requireActor } from "@/lib/require-actor";
import { resolveTenantId } from "@/lib/tenant";
import { rawQuery } from "@/lib/supabase";
import { gradingPaused } from "@/lib/grading-store";
import { recoverMissingGrade, type RecoveryResult } from "@/lib/grading-worker";

export async function getGradingPause(): Promise<{ paused: string | null; error?: string }> {
  await requireActor();
  try { return { paused: await gradingPaused() }; }
  catch { return { paused: null, error: "Could not check grading status. Reload to try again." }; }
}

/** Explicit user retry resets the retry budget, but never steals a live lease. */
export async function retryMissingGrades(resume = false): Promise<RecoveryResult> {
  const actor = await requireActor();
  const tenant = await resolveTenantId();
  if (resume) {
    const { error } = await rawQuery(`with resumed as (
      delete from app_settings where tenant_id=$1 and key='grading_pause'
    ) update jobs set grading_attempts=0, grading_next_at=null, grading_state='pending', grading_error=null, grading_lease=null
      where tenant_id=$1 and fit_score is null
        and (grading_state <> 'running' or grading_next_at <= now())`, [tenant], tenant);
    if (error) return { graded: 0, attempted: 0, error: "Could not resume grading. Try again shortly." };
  }
  try { return await recoverMissingGrade(actor.isAdmin); }
  catch { return { graded: 0, attempted: 0, error: "Could not recover missing grades. Try again shortly." }; }
}
