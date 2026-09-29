import type { CrawlIssue } from "@/lib/watchlist-display";

export interface WatchlistCheckItem {
  company: string;
  issue: CrawlIssue;
  outcome?: { rolesFound: number; newRoles: number };
}

/** Explain a shared problem once, without merging different recorded causes. */
export default function WatchlistCheckGroups({ items, onReview }: {
  items: WatchlistCheckItem[];
  onReview: (company: string) => void;
}) {
  const groups: { issue: CrawlIssue; companies: WatchlistCheckItem[] }[] = [];
  for (const item of items) {
    const group = groups.find(({ issue }) => issue.label === item.issue.label &&
      issue.explanation === item.issue.explanation && issue.nextStep === item.issue.nextStep);
    if (group) group.companies.push(item);
    else groups.push({ issue: item.issue, companies: [item] });
  }

  return <ul className="divide-y divide-slate" aria-label="Companies and next steps">
    {groups.map(({ issue, companies }) => <li key={companies[0].company}
      className="grid gap-4 py-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:gap-8">
      <div>
        <h4 className="text-sm font-semibold">{issue.label.replace(/^Partial · /, "")}
          <span className="ml-2 inline-block font-normal text-ink/60">{companies.length} {companies.length === 1 ? "company" : "companies"}</span>
        </h4>
        <p className="mt-1 max-w-prose break-words text-sm text-ink/60">{issue.explanation}</p>
        <p className="mt-2 max-w-prose break-words text-sm text-ink/90"><span className="font-medium">Next step: </span>{issue.nextStep}</p>
      </div>
      <ul className="flex flex-wrap content-start items-start gap-2" aria-label={`${issue.label.replace(/^Partial · /, "")} companies`}>
        {companies.map(({ company, outcome }) => <li key={company} className="min-w-0 max-w-full">
          <button type="button" onClick={() => onReview(company)} aria-label={`Review ${company}`}
            className="max-w-full break-words rounded-md border border-slate bg-canvas px-3 py-2 text-sm font-medium hover:border-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">
            {company}
          </button>
          {outcome && outcome.rolesFound > 0 && <p className="mt-1 text-xs text-ink/60">{outcome.rolesFound} role{outcome.rolesFound === 1 ? "" : "s"} found · {outcome.newRoles} new</p>}
        </li>)}
      </ul>
    </li>)}
  </ul>;
}
