"use client";
import {useState} from "react";
import type {DeepSearchAdvice} from "@/lib/deep-search-advice";
import {deepSearchBatchPlan} from "@/lib/watchlist-selection";
import {SearchAttemptSummary} from "./DeepSearchControl";
import type {RemovalReason} from "@/lib/watchlist-removal";

export default function WatchlistBulkReview({kind, names, advice, busy, onCancel, onRemove, onSearch, onReview}: {
  kind: "deep" | "remove"; names: string[]; advice: DeepSearchAdvice[]; busy: boolean;
  onCancel: () => void; onRemove: (reason: RemovalReason) => void;
  onSearch: (ready: {company: string; acknowledgementKey?: string}[]) => void;
  onReview: (company: string) => void;
}) {
  const [acknowledged, setAcknowledged] = useState<Record<string, string>>({});
  const [reason, setReason] = useState<RemovalReason | "">("");
  const plan = deepSearchBatchPlan(names, advice, acknowledged);
  return <section className="mb-4 border-y border-slate bg-white px-4 py-4" aria-label={kind === "deep" ? "Review selected Deep searches" : "Review watchlist removal"}>
    <h3 className="text-base font-semibold">{kind === "deep" ? "Review Deep search" : "Remove from watchlist"} · {names.length} selected</h3>
    <p className="mt-1 max-w-prose text-sm text-ink/70">{kind === "deep"
      ? "Runs one company at a time, with up to 5 paid web searches per company, plus AI processing. Your spending limits apply. Keep this page open until the batch finishes."
      : "Stops automatic checks. Saved roles and history stay available. You can restore these companies from Not tracked."}</p>
    {kind === "remove" && <fieldset className="mt-3 space-y-2 text-sm" disabled={busy}>
      <legend className="mb-2 font-medium">Why are you removing {names.length === 1 ? "this company" : "these companies"}?</legend>
      <label className="flex items-start gap-2"><input type="radio" name="removal-reason" value="not_interested" checked={reason === "not_interested"} onChange={() => setReason("not_interested")} className="mt-1" /><span>Not interested<span className="block text-ink/70">Hide from future Discover suggestions until you restore.</span></span></label>
      <label className="flex items-start gap-2"><input type="radio" name="removal-reason" value="source_problem" checked={reason === "source_problem"} onChange={() => setReason("source_problem")} className="mt-1" /><span>Careers page problem<span className="block text-ink/70">Pause checks. Update the page or retry when you restore; changes won’t be monitored while paused.</span></span></label>
      <label className="flex items-start gap-2"><input type="radio" name="removal-reason" value="stopped" checked={reason === "stopped"} onChange={() => setReason("stopped")} className="mt-1" /><span>Just stop tracking for now</span></label>
    </fieldset>}
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
      <button type="button" disabled={busy || (kind === "remove" && !reason) || (kind === "deep" && (plan.ready.length === 0 || plan.unreviewed.length > 0))}
        onClick={() => kind === "deep" ? onSearch(plan.ready) : reason && onRemove(reason)}
        className="rounded-md border border-ink bg-ink px-3 py-2 text-sm font-medium text-white disabled:opacity-50">
        {kind === "deep" ? `Deep search ${plan.ready.length} ${plan.ready.length === 1 ? "company" : "companies"}` : `Remove ${names.length} ${names.length === 1 ? "company" : "companies"}`}
      </button>
      <button type="button" disabled={busy} onClick={onCancel} className="rounded-md border border-slate px-3 py-2 text-sm hover:border-ink disabled:opacity-50">Cancel</button>
    </div>
  </section>;
}
