import type { WatchlistBatchProgress } from "@/lib/watchlist-batch";
import { crawlIssueDisplay, crawlOutcomeText } from "@/lib/watchlist-display";

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
  // Share an explanation only when both the recorded reason and remedy match.
  // Different pending counts or source errors keep their own group.
  const groups: { issue: NonNullable<(typeof results)[number]["issue"]>; companies: typeof followUps }[] = [];
  for (const result of followUps) {
    const issue = result.issue!;
    const group = groups.find(item => item.issue.label === issue.label &&
      item.issue.explanation === issue.explanation && item.issue.nextStep === issue.nextStep);
    if (group) group.companies.push(result);
    else groups.push({ issue, companies: [result] });
  }

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
      <p className="mt-1 text-sm text-ink/70">Grouped by reason. Choose a company to open its careers URL and check controls.</p>
      <ul className="mt-4 divide-y divide-slate" aria-label="Companies and next steps">
        {groups.map(({ issue, companies }) => <li key={companies[0].company} className="py-4 first:pt-0">
          <p className="text-sm font-semibold text-[#92400E]">{issue.label.replace(/^Partial · /, "")} · {companies.length} {companies.length === 1 ? "company" : "companies"}</p>
          <p className="mt-1 max-w-prose break-words text-sm text-ink/80">{issue.explanation}</p>
          <p className="mt-2 max-w-prose break-words text-sm text-ink/80"><span className="font-medium text-ink">Next step: </span>{issue.nextStep}</p>
          <ul className="mt-3 flex flex-wrap gap-x-3 gap-y-2">
            {companies.map(({ company, outcome }) => <li key={company} className="min-w-0 max-w-full">
              <button type="button" onClick={() => onReview(company)}
                aria-label={`Review ${company}`}
                className="max-w-full break-words rounded-md border border-slate px-3 py-2 text-sm font-medium hover:border-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">
                Review {company}
              </button>
              {outcome && outcome.rolesFound > 0 && <p className="mt-1 text-xs text-ink/70">{outcome.rolesFound} role{outcome.rolesFound === 1 ? "" : "s"} found · {outcome.newRoles} new</p>}
            </li>)}
          </ul>
        </li>)}
      </ul>
    </section> : progress.completed > 0 && <p className="mt-2 text-sm text-ink/70">No follow-up needed for the completed checks.</p>}

    {completed.length > 0 && <details className="mt-4 border-t border-slate pt-3">
      <summary className="cursor-pointer text-sm font-medium">{completed.length} {completed.length === 1 ? "company completed" : "companies completed"} — no action needed</summary>
      <ul className="mt-3 space-y-2 text-sm text-ink/70" aria-label="Completed checks">
        {completed.map(result => <li key={result.company}><span className="font-medium text-ink">{result.company}: </span>{crawlOutcomeText(result.outcome!)}</li>)}
      </ul>
    </details>}
  </div>;
}
