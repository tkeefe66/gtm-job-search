export interface SearchAttempt {
  id: string; startedAt: string; finishedAt: string | null; status: string;
  rolesFound: number; newRoles: number; costMicrousd: number | null; costComplete: boolean;
  costStatus: "complete" | "unknown" | "running" | "unrecorded";
  error: string | null;
}
export interface CompanySearchEvidence {
  company: string; modelRetryAfter: string | null;
  latestCheck: { method: string | null; status: string; startedAt: string } | null;
  attempts: SearchAttempt[];
}
export interface PaidSearchAvailability { blocked?: string; availableCents?: number | null }
export interface DeepSearchAdvice {
  company: string;
  state: "blocked" | "running" | "retry" | "direct" | "promising" | "limited" | "untested";
  label: string; reason: string; blocked: boolean; requiresAcknowledgement: boolean;
  acknowledgementKey: string;
  attempts: SearchAttempt[];
}

/** Evidence-based guidance, never a promise of jobs or a success probability. */
export function deepSearchAdvice(evidence: CompanySearchEvidence, availability: PaidSearchAvailability, now = new Date()): DeepSearchAdvice {
  const last = evidence.attempts[0];
  const acknowledgementKey = JSON.stringify([last ?? null, evidence.modelRetryAfter, evidence.latestCheck]);
  const result = (state: DeepSearchAdvice["state"], label: string, reason: string, blocked = false, requiresAcknowledgement = false): DeepSearchAdvice =>
    ({ company: evidence.company, state, label, reason, blocked, requiresAcknowledgement, acknowledgementKey, attempts: evidence.attempts });
  if (availability.blocked !== undefined) return result("blocked", "Paid search is blocked", availability.blocked, true);
  const unfinished = last && (!last.finishedAt || last.status === "running");
  if (unfinished && now.getTime() - Date.parse(last.startedAt) < 30 * 60 * 1000)
    return result("running", "Search already running", "Wait for this search to finish, then refresh its results before starting another.", true);
  const failed = last && (unfinished || !["ok", "partial", "empty", "unchanged"].includes(last.status));
  const paused = evidence.modelRetryAfter !== null && Date.parse(evidence.modelRetryAfter) > now.getTime();
  const direct = evidence.latestCheck?.method === "fetch" && ["ok", "empty", "unchanged"].includes(evidence.latestCheck.status);
  if (direct) return result("direct", "Use normal check", "The latest direct check worked. Try Check now first; paid search may be unnecessary.", false, !!failed || paused);
  if (failed) return result("retry", "Retry not recommended", unfinished
    ? "The last search has no confirmed outcome. Review saved results and usage before paying to retry."
    : last.status === "needs_url" ? "The last paid search did not find a careers page. Add the company's careers URL before paying to retry."
    : last.status === "skipped" ? "The last paid search stopped before completing the check. Review its result and cost before paying to retry."
    : "The last paid search failed. Review its result and cost before paying to retry.", false, true);
  if (paused) return result("retry", "Retry not recommended", "Automatic paid search is paused after repeated failures. Review the cause before paying to retry.", false, true);
  if (last && ["ok", "partial", "empty", "unchanged"].includes(last.status)) {
    if (last.newRoles > 0) return result("promising", "Has found new roles before", `The last search added ${last.newRoles} new role${last.newRoles === 1 ? "" : "s"}. Review their fit in Roles; another search may find nothing new.`);
    return result("limited", "Last search added no new roles", `${last.status === "partial" ? "The search returned partial results" : "The search completed"} and added no new roles. Wait for new openings or use Check now first.`);
  }
  return result("untested", "Untested fallback", "No completed paid search is recorded for this company. It may find listings the direct reader missed, but success is uncertain.");
}

export function searchAttemptDuration(attempt: SearchAttempt): string {
  if (!attempt.finishedAt) return "No finish recorded";
  const seconds = Math.max(0, Math.round((Date.parse(attempt.finishedAt) - Date.parse(attempt.startedAt)) / 1000));
  if (!Number.isFinite(seconds)) return "Duration not recorded";
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
