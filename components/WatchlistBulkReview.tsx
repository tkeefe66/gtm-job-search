"use client";
import {useState} from "react";
import type {DeepSearchAdvice} from "@/lib/deep-search-advice";
import {deepSearchBatchPlan} from "@/lib/watchlist-selection";
import {SearchAttemptSummary} from "./DeepSearchControl";

export default function WatchlistBulkReview({kind, names, advice, busy, onCancel, onRemove, onSearch, onReview}: {
  kind: "deep" | "remove"; names: string[]; advice: DeepSearchAdvice[]; busy: boolean;
  onCancel: () => void; onRemove: () => void;
  onSearch: (ready: {company: string; acknowledgementKey?: string}[]) => void;
  onReview: (company: string) => void;
}) {
  const [acknowledged, setAcknowledged] = useState<Record<string, string>>({});
  const plan = deepSearchBatchPlan(names, advice, acknowledged);
  return <section className="mb-4 border-y border-slate bg-white px-4 py-4" aria-label={kind === "deep" ? "Review selected Deep searches" : "Review watchlist removal"}>
    <h3 className="text-base font-semibold">{kind === "deep" ? "Review Deep search" : "Remove from watchlist"} · {names.length} selected</h3>
    <p className="mt-1 max-w-prose text-sm text-ink/70">{kind === "deep"
      ? "Runs one company at a time, with up to 5 paid web searches per company, plus AI processing. Your spending limits apply. Keep this page open until the batch finishes."
      : "Stops automatic checks for these companies. Saved roles and history stay available. You can restore companies from Not tracked using Resume."}</p>
    {kind === "remove" ? <p className="mt-3 break-words text-sm font-medium">{names.join(", ")}</p> : <ul className="mt-3 divide-y divide-slate">
      {names.map(company => {
        const item = advice.find(entry => entry.company === company);
        return <li key={company} className="py-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm"><strong>{company}</strong><span className="ml-2 text-ink/70">{item?.label ?? "Recommendation unavailable"}{!item || item.blocked ? " · Will be skipped" : ""}</span></p>
            <button type="button" disabled={busy} onClick={() => onReview(company)} className="text-xs underline underline-offset-2">View company</button>
          </div>
          <p className="mt-1 max-w-prose text-sm text-ink/70">{item?.reason ?? "Cancel and refresh the watchlist before trying this company."}</p>
          {item?.attempts[0] && <div className="mt-1"><SearchAttemptSummary attempt={item.attempts[0]} /></div>}
          {item?.requiresAcknowledgement && !item.blocked && <label className="mt-2 flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" disabled={busy} checked={acknowledged[company] === item.acknowledgementKey}
              onChange={event => setAcknowledged(previous => ({...previous, [company]: event.target.checked ? item.acknowledgementKey : ""}))} />
            I reviewed {company}&apos;s previous result and want to pay to retry.
          </label>}
        </li>;
      })}
    </ul>}
    {kind === "deep" && <p className="mt-3 text-sm" role="status">{plan.ready.length} ready · {plan.unreviewed.length} need retry confirmation · {plan.blocked.length} will be skipped</p>}
    <div className="mt-4 flex flex-wrap gap-2">
      <button type="button" disabled={busy || (kind === "deep" && (plan.ready.length === 0 || plan.unreviewed.length > 0))}
        onClick={() => kind === "deep" ? onSearch(plan.ready) : onRemove()}
        className="rounded-md border border-ink bg-ink px-3 py-2 text-sm font-medium text-white disabled:opacity-50">
        {kind === "deep" ? `Deep search ${plan.ready.length} ${plan.ready.length === 1 ? "company" : "companies"}` : `Remove ${names.length} ${names.length === 1 ? "company" : "companies"}`}
      </button>
      <button type="button" disabled={busy} onClick={onCancel} className="rounded-md border border-slate px-3 py-2 text-sm hover:border-ink disabled:opacity-50">Cancel</button>
    </div>
  </section>;
}
