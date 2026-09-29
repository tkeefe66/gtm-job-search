import type { WatchlistBatchProgress } from "@/lib/watchlist-batch";
import { crawlIssueDisplay, crawlOutcomeText } from "@/lib/watchlist-display";
import WatchlistCheckGroups from "./WatchlistCheckGroups";

/** Counts and visible follow-ups come from the same results, including unconfirmed requests. */
export default function WatchlistBatchResults({ progress, onReview }: {
  progress: WatchlistBatchProgress;
  onReview: (company: string) => void;
}) {
  const results = progress.results.map(result => ({
    ...result,
    issue: result.error !== undefined || !result.outcome ? {
      label: "Result not confirmed",
      explanation: result.error?.trim() || "The connection ended before this check returned a result. Server work may still finish.",
      nextStep: "Reload the watchlist to inspect saved results before starting another check.",
    } : crawlIssueDisplay(result.outcome.status, result.outcome.error),
  }));
  const followUps = results.filter(result => result.issue !== null);
  const completed = results.filter(result => result.issue === null);
  const newRoles = results.reduce((sum, result) => sum + (result.outcome?.newRoles ?? 0), 0);

  return <div className="mt-4 border-t border-slate pt-4">
    <p className="text-sm font-medium" role="status" aria-live="polite">
      {progress.currentCompany ? `Checking ${progress.currentCompany} · ` :
        progress.interrupted ? "Batch interrupted · " : progress.stopped ? "Batch stopped · " : "Batch finished · "}
      {progress.completed} of {progress.total} checks returned · {newRoles} new role{newRoles === 1 ? "" : "s"}
    </p>
    {progress.interrupted && <p className="mt-1 text-sm text-[#92400E]">The last request may still finish. Reload to see saved results before retrying.</p>}
    {progress.stopped && <p className="mt-1 text-sm text-ink/70">{progress.total - progress.completed} companies were not checked. Completed results are saved.</p>}

    {followUps.length > 0 ? <section className="mt-5" aria-label="Companies needing a next step">
      <h4 className="text-sm font-semibold">{followUps.length} {followUps.length === 1 ? "company needs" : "companies need"} a next step</h4>
      <p className="mt-1 text-sm text-ink/70">Select a company to review its careers link and check options.</p>
      <WatchlistCheckGroups items={followUps.map(result => ({ ...result, issue: result.issue! }))} onReview={onReview} />
    </section> : progress.completed > 0 && <p className="mt-2 text-sm text-ink/70">No follow-up needed for the completed checks.</p>}

    {completed.length > 0 && <details className="mt-4 border-t border-slate pt-3">
      <summary className="cursor-pointer text-sm font-medium">{completed.length} {completed.length === 1 ? "company completed" : "companies completed"} — no action needed</summary>
      <ul className="mt-3 space-y-2 text-sm text-ink/70" aria-label="Completed checks">
        {completed.map(result => <li key={result.company}><span className="font-medium text-ink">{result.company}: </span>{crawlOutcomeText(result.outcome!)}</li>)}
      </ul>
    </details>}
  </div>;
}
