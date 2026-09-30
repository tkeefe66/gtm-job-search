import type { CrawlIssue } from "@/lib/watchlist-display";
import CompanySelectionCheckbox from "./CompanySelectionCheckbox";

export interface CompanyGroupSelection {
  selected: ReadonlySet<string>; disabled: boolean; onToggle: (names: string[]) => void;
}

export interface WatchlistCheckItem {
  company: string;
  issue: CrawlIssue;
  outcome?: { rolesFound: number; newRoles: number };
}

/** Explain a shared problem once, without merging different recorded causes. */
export default function WatchlistCheckGroups({ items, onReview, selection }: {
  items: WatchlistCheckItem[];
  onReview: (company: string) => void;
  selection?: CompanyGroupSelection;
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
        {selection && <label className="mt-2 inline-flex items-center gap-2 py-1 text-xs text-ink/70">
          <CompanySelectionCheckbox label={`Select all ${issue.label.replace(/^Partial · /, "")} companies`}
            checked={companies.every(item => selection.selected.has(item.company))}
            mixed={companies.some(item => selection.selected.has(item.company)) && !companies.every(item => selection.selected.has(item.company))}
            disabled={selection.disabled} onChange={() => selection.onToggle(companies.map(item => item.company))} />
          Select group
        </label>}
        <p className="mt-1 max-w-prose break-words text-sm text-ink/60">{issue.explanation}</p>
        <p className="mt-2 max-w-prose break-words text-sm text-ink/90"><span className="font-medium">Next step: </span>{issue.nextStep}</p>
      </div>
      <ul className="flex flex-wrap content-start items-start gap-2" aria-label={`${issue.label.replace(/^Partial · /, "")} companies`}>
        {companies.map(({ company, outcome }) => <li key={company} className="min-w-0 max-w-full">
          <div className={`flex items-center rounded-md border ${selection?.selected.has(company) ? "border-ink bg-canvas" : "border-slate bg-canvas"}`}>
          {selection && <label className="flex self-stretch items-center px-3">
            <CompanySelectionCheckbox label={`Select ${company} in group`} checked={selection.selected.has(company)} disabled={selection.disabled} onChange={() => selection.onToggle([company])} />
          </label>}
          <button type="button" onClick={() => onReview(company)} aria-label={`Review ${company}`}
            className="min-w-0 max-w-full break-words rounded-md px-3 py-2 text-sm font-medium hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">
            {company}
          </button>
          </div>
          {outcome && outcome.rolesFound > 0 && <p className="mt-1 text-xs text-ink/60">{outcome.rolesFound} role{outcome.rolesFound === 1 ? "" : "s"} found · {outcome.newRoles} new</p>}
        </li>)}
      </ul>
    </li>)}
  </ul>;
}
