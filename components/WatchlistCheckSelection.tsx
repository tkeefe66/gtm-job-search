import type { TrackedCompany } from "@/lib/types";
import { crawlIssueDisplay } from "@/lib/watchlist-display";
import type { WatchlistBatchProgress } from "@/lib/watchlist-batch";
import WatchlistCheckGroups from "./WatchlistCheckGroups";

export default function WatchlistCheckSelection({ companies, onReview, previousBatch }: {
  companies: TrackedCompany[];
  onReview: (company: string) => void;
  previousBatch?: WatchlistBatchProgress | null;
}) {
  const groups = <WatchlistCheckGroups onReview={onReview} items={companies.map(company => ({
    company: company.company,
    issue: crawlIssueDisplay(company.last_crawl_status, company.last_crawl_error) ??
      (company.consecutive_failures >= 3 ? {
        label: "Repeated checks failed",
        explanation: `${company.consecutive_failures} unsuccessful checks in a row.`,
        nextStep: "Review the careers URL before retrying.",
      } : {
        label: company.last_checked_at ? "Due for a check" : "Not checked yet",
        explanation: company.last_checked_at ? "The scheduled interval has passed." : "No previous check is recorded.",
        nextStep: "Use the check button above to look for new roles.",
      }),
  }))} />;
  // Keep the current selection inspectable after a batch, including companies
  // left unchecked by Stop and companies tracked after those results were saved.
  return previousBatch ? <details open={previousBatch.stopped || previousBatch.interrupted} className="pt-3">
    <summary className="cursor-pointer text-sm font-medium">{companies.length} {companies.length === 1 ? "company selected" : "companies selected"} for the next check</summary>
    {groups}
  </details> : groups;
}
