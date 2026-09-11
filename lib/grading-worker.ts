import { randomUUID } from "node:crypto";
import { getJobStatuses } from "@/app/actions/jobs";
import { scoreFit } from "@/app/actions/parse-role";
import { loadScoringInputs } from "./search-criteria";
import { resolveTenantId } from "./tenant";
import { rawQuery } from "./supabase";
import { withBudget } from "./metered";
import { autoFileStatus, shouldAutoFile } from "./fit-cutoff";
import { scoringArgsFor, type ScoredJobRow } from "./rescore-scope";
import { CLAIM_GRADE_SQL, gradingFailure } from "./grading-policy";
import { gradingPaused, recordGradeFailure, updateMissingGrade } from "./grading-store";

export interface RecoveryResult { graded: number; attempted: number; error?: string }

/** One role per request keeps recovery below the proxy timeout and budgets current. */
export async function recoverMissingGrade(isAdmin: boolean): Promise<RecoveryResult> {
  const paused = await gradingPaused();
  if (paused) return { graded: 0, attempted: 0, error: paused };
  const statuses = await getJobStatuses();
  if (statuses.error !== undefined) return { graded: 0, attempted: 0, error: "Could not read status settings. Grading was not started." };
  const terminal = statuses.statuses.filter(s => s.bucket === "terminal" || s.hidden).map(s => s.key);
  const fitInputs = await loadScoringInputs();
  if (!fitInputs.fitBrain.trim()) return { graded: 0, attempted: 0, error: "Finish your profile in Settings before retrying grades." };
  const tenant = await resolveTenantId();
  const budget = await withBudget({ action: "score-fit", estimateCents: 2, isAdmin, fn: async (): Promise<RecoveryResult> => {
    const lease = randomUUID();
    const { data, error } = await rawQuery<ScoredJobRow & {grading_attempts:number; grading_chosen:boolean}>(CLAIM_GRADE_SQL, [tenant,terminal,lease], tenant);
    if (error) return { graded: 0, attempted: 0, error: "Could not claim a missing grade. Try again shortly." };
    const row = data[0];
    if (!row) return { graded: 0, attempted: 0 };
    try {
      const scored = await scoreFit({ ...scoringArgsFor(row), fitInputs });
      if (scored.score <= 0) {
        const failure = { kind: scored.failureKind ?? "transient" as const,
          message: scored.error || "Grading failed temporarily. It will retry automatically." };
        await recordGradeFailure(row.id,lease,row.grading_attempts,failure);
        return { graded: 0, attempted: 1, error: failure.message };
      }
      const fileInto = autoFileStatus(statuses.statuses);
      const file = !row.grading_chosen && fileInto !== null && shouldAutoFile({
        score: scored.score, wasRead: typeof row.posting?.enrichedAt === "string", status: row.status });
      const saved = await updateMissingGrade(row.id, {fit_score:scored.score, fit_summary:scored.rationale, ...(file ? {status:fileInto!} : {})}, lease, terminal);
      if (saved.error !== undefined) return { graded: 0, attempted: 1, error: saved.error };
      console.log(`grading: recovery ${saved.saved ? "saved" : "superseded"}`);
      return { graded: saved.saved ? 1 : 0, attempted: 1 };
    } catch (error) {
      console.error("grading: recovery failed", error);
      const failure = gradingFailure(error);
      await recordGradeFailure(row.id,lease,row.grading_attempts,failure);
      return { graded: 0, attempted: 1, error: failure.message };
    }
  }});
  if (budget.capped || budget.error !== undefined) return { graded: 0, attempted: 0, error: budget.capped || budget.error || "Could not check the grading budget." };
  return budget.result!;
}
