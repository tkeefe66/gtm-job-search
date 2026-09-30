import type { CompanySpendSummary } from "@/app/actions/watchlist";
import type { TrackedCompany } from "@/lib/types";
import { companyCostDisplay, crawlIssueDisplay } from "@/lib/watchlist-display";
import { nextCheckDue } from "@/lib/crawl-schedule";

function date(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Not recorded";
}

/** Explicitly distinguishes a source check from a successful paid model run. */
export default function CompanyCheckDetails({ company, summary, costError }: {
  company: TrackedCompany; summary?: CompanySpendSummary; costError?: string | null;
}) {
  const costs = companyCostDisplay(summary);
  const issue = crawlIssueDisplay(company.last_crawl_status, company.last_crawl_error);
  const next = nextCheckDue(company.last_attempted_at ?? company.last_checked_at, company.crawl_interval_days, company.next_attempt_at);
  return <div className="mt-3 rounded-md border border-slate bg-white p-3 text-xs text-ink/60">
    <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
      <div><dt>Last attempt</dt><dd className="mt-0.5 text-ink">{date(company.last_attempted_at ?? company.last_checked_at)}</dd></div>
      <div><dt>Last successful check</dt><dd className="mt-0.5 text-ink">{date(company.last_successful_check_at)}</dd></div>
      <div className="sm:col-span-2"><dt>Next scheduled check</dt><dd className="mt-0.5 text-ink">{next ? date(next.toISOString()) : "Due now"}</dd></div>
      <div><dt>Latest check AI cost</dt><dd className="mt-0.5 tabular-nums text-ink">{costError ? "Unavailable" : costs.latest}</dd></div>
      <div><dt>AI cost this month (UTC)</dt><dd className="mt-0.5 tabular-nums text-ink">{costError ? "Unavailable" : costs.month}</dd></div>
    </dl>
    {costs.latestResult && !costError && <p className="mt-2">Latest result: {costs.latestResult}</p>}
    {issue && <div className="mt-3 break-words text-[#92400E]">
      <p className="font-medium">Last check: {issue.label}</p>
      <p className="mt-1">{issue.explanation}</p>
      <p className="mt-1"><span className="font-medium">Next step: </span>{issue.nextStep}</p>
    </div>}
    {company.model_retry_after && new Date(company.model_retry_after).getTime() > Date.now() && <p className="mt-2 text-[#92400E]">Automatic paid search is waiting until {date(company.model_retry_after)} after unsuccessful attempts. Review the Deep search recommendation below before retrying.</p>}
    {costError ? <p className="mt-2 text-[#92400E]" role="alert">{costError}</p> : costs.uncertainty && <p className="mt-2 text-[#92400E]">{costs.uncertainty}</p>}
    <p className="mt-2 text-ink/40">Costs cover requests recorded with this company. Earlier checks without cost records are not shown as free.</p>
  </div>;
}
