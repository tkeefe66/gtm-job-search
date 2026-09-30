"use client";

import { useState } from "react";
import { searchAttemptDuration, type DeepSearchAdvice, type SearchAttempt } from "@/lib/deep-search-advice";
import { crawlIssueDisplay, formatAICost } from "@/lib/watchlist-display";

export function SearchAttemptSummary({ attempt }: { attempt: SearchAttempt }) {
  const result = !attempt.finishedAt || attempt.status === "running" ? "Outcome not confirmed"
    : attempt.status === "error" ? "Failed" : attempt.status === "needs_url" ? "No careers page found"
    : attempt.status === "skipped" ? "Stopped before completion" : attempt.status === "partial" ? "Partial results"
    : ["ok", "empty", "unchanged"].includes(attempt.status) ? "Completed" : "Outcome not confirmed";
  const cost = attempt.costComplete ? formatAICost(attempt.costMicrousd) : attempt.costMicrousd === null
    ? attempt.costStatus === "unrecorded" ? "Cost not recorded" : attempt.costStatus === "running" ? "Cost still pending" : "Cost unknown"
    : `${formatAICost(attempt.costMicrousd)} recorded; total unknown`;
  return <p className="text-xs text-ink/70">
    <time dateTime={attempt.startedAt}>{new Date(attempt.startedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time>
    {` · ${result} · ${attempt.newRoles} new role${attempt.newRoles === 1 ? "" : "s"} · ${searchAttemptDuration(attempt)} · ${cost}`}
  </p>;
}

/** Retry acknowledgement is local to this exact recommendation, reset by the parent key. */
export default function DeepSearchControl({ advice, error, busy, onSearch, onRefresh }: {
  advice?: DeepSearchAdvice; error?: string | null; busy: boolean;
  onSearch: (acknowledgementKey?: string) => void; onRefresh: () => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const last = advice?.attempts[0];
  const issue = last && crawlIssueDisplay(last.status, last.error);
  return <section className="mt-4 border-t border-slate pt-3" aria-label="Deep search recommendation">
    <div className="flex flex-col items-start justify-between gap-3 sm:flex-row">
      <div className="min-w-0 flex-1">
        <h4 className="text-sm font-semibold">Deep search: {advice?.label ?? (error ? "Recommendation unavailable" : "Checking readiness…")}</h4>
        <p className="mt-1 max-w-prose text-sm text-ink/70" role={error ? "alert" : undefined}>{error ?? advice?.reason ?? "Loading search history and spending allowance."}</p>
      </div>
      <button type="button" onClick={() => onSearch(acknowledged ? advice?.acknowledgementKey : undefined)}
        disabled={busy || !advice || !!error || advice.blocked || (advice.requiresAcknowledgement && !acknowledged)}
        className="w-full shrink-0 rounded-md border border-ink px-3 py-2 text-sm font-medium hover:bg-ink hover:text-white disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto">
        {advice?.requiresAcknowledgement ? "Retry Deep search" : "Run Deep search"}
      </button>
    </div>
    {last && <div className="mt-2"><SearchAttemptSummary attempt={last} /></div>}
    {issue && <details className="mt-2 text-xs text-ink/70">
      <summary className="cursor-pointer">Last search details</summary>
      <p className="mt-1 max-w-prose break-words">{issue.explanation}</p>
      <p className="mt-1 max-w-prose">{issue.nextStep}</p>
    </details>}
    {advice && advice.attempts.length > 1 && <details className="mt-2 text-xs text-ink/70">
      <summary className="cursor-pointer">Earlier searches ({advice.attempts.length - 1})</summary>
      <ul className="mt-2 space-y-2">{advice.attempts.slice(1).map(attempt => <li key={attempt.id}><SearchAttemptSummary attempt={attempt} /></li>)}</ul>
    </details>}
    {advice?.requiresAcknowledgement && !advice.blocked && <label className="mt-3 flex items-start gap-2 text-sm text-ink/80">
      <input type="checkbox" className="mt-1" checked={acknowledged} disabled={busy} onChange={event => setAcknowledged(event.target.checked)} />
      I reviewed the previous result and want to pay for another attempt.
    </label>}
    <p className="mt-2 text-xs text-ink/60">Up to 5 paid web searches, plus any AI processing. Your spending limits apply.</p>
    {(error || advice?.blocked) && <button type="button" onClick={onRefresh} disabled={busy} className="mt-2 text-xs underline underline-offset-2">Refresh recommendation</button>}
    {advice?.state === "blocked" && <a href="/settings" className="ml-3 text-xs underline underline-offset-2">Open Settings</a>}
  </section>;
}
