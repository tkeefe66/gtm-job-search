"use client";

import Link from "next/link";
import { useState } from "react";
import { DISPOSITIONS, FIT_REASONS, dispositionLabel, groupSources, safeSourceUrl, type SourceRecord } from "@/lib/job-dispositions";

const date = (value: string) => new Date(value).toLocaleDateString(undefined, {month:"short",day:"numeric",year:"numeric"});

export default function SourceQuality({ startedAt, records }: { startedAt: string; records: SourceRecord[] }) {
  const [cohort, setCohort] = useState<"new" | "legacy">("new");
  const [actor, setActor] = useState<"all" | "user" | "automation">("all");
  const groups = groupSources(records, cohort);
  const newCount = records.filter(r => r.cohort === "new").length;
  const legacyCount = records.filter(r => r.cohort === "legacy").length;
  return <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
    <Link href="/roles" className="text-sm text-ink/60 underline underline-offset-4">Back to roles</Link>
    <h1 className="mt-5 font-heading text-3xl font-semibold">Source quality</h1>
    <p className="mt-2 max-w-3xl text-sm leading-6 text-ink/70">Tracking since {date(startedAt)}. Compare where your roles come from and why they leave your pipeline. Personal fit and missing jobs are separate signals; a posting closing later does not mean the source was inaccurate.</p>
    <div className="mt-6 flex flex-wrap items-end justify-between gap-4 border-b border-slate pb-4">
      <div className="flex flex-wrap gap-2" aria-label="Source report cohort">
        <button onClick={() => setCohort("new")} aria-pressed={cohort === "new"} className={`rounded-md border px-3 py-2 text-sm ${cohort === "new" ? "border-ink bg-ink text-white" : "border-slate bg-white"}`}>New roles ({newCount})</button>
        <button onClick={() => setCohort("legacy")} aria-pressed={cohort === "legacy"} className={`rounded-md border px-3 py-2 text-sm ${cohort === "legacy" ? "border-ink bg-ink text-white" : "border-slate bg-white"}`}>Feedback on older roles ({legacyCount})</button>
      </div>
      <label className="text-xs text-ink/70">Feedback from
        <select value={actor} onChange={e => setActor(e.target.value as typeof actor)} className="ml-2 rounded-md border border-slate bg-white p-2 text-sm text-ink">
          <option value="all">You and the app</option><option value="user">You</option><option value="automation">The app</option>
        </select>
      </label>
    </div>
    <p className="mt-3 text-xs leading-5 text-ink/60">{cohort === "new" ? "Counts use all roles sourced since tracking began, including those already dead at discovery." : "Only changes made since tracking began appear here. Older statuses have not been reinterpreted; this is not a historical source audit."} Outcomes reflect each role’s latest disposition. Reopened roles stay in the total but no longer count as rejected. Filtering feedback never changes the denominator.</p>
    {groups.length === 0 ? <div className="mt-8 rounded-lg border border-slate bg-white p-8">
      <h2 className="font-heading text-lg font-medium">{cohort === "new" ? "Your next discoveries start the report" : "No new feedback on older roles"}</h2>
      <p className="mt-2 text-sm text-ink/65">{cohort === "new" ? "Run a search or let the crawler find roles. Their original sources will appear here automatically." : "Choosing a disposition on an older role will record that new decision here."}</p>
      <Link href={cohort === "new" ? "/discover" : "/roles"} className="mt-5 inline-block rounded-md bg-ink px-4 py-2 text-sm text-white">{cohort === "new" ? "Find roles" : "View roles"}</Link>
    </div> : <div className="mt-6 space-y-5">
      {groups.map(group => {
        const feedback = group.records.filter(r => actor === "all" || r.actor === actor);
        return <section key={group.name} className="overflow-hidden rounded-lg border border-slate bg-white">
          <div className="flex flex-wrap items-start justify-between gap-3 p-5">
            <div><h2 className="break-all font-heading text-xl font-medium">{group.name}</h2>
              <p className="mt-1 text-xs text-ink/60">{group.total} {cohort === "new" ? "roles sourced" : "older roles with new activity"}{group.total < 10 ? "; small sample" : ""}</p></div>
            <p className="text-xs text-ink/65">Current dispositions: {group.humanFeedback} from you, {group.automatedFeedback} from the app</p>
          </div>
          <div className="grid grid-cols-2 gap-px border-y border-slate bg-slate sm:grid-cols-5">
            {DISPOSITIONS.map(d => { const count = feedback.filter(r => r.disposition === d.key).length; return <div key={d.key} className="bg-canvas p-4" title={d.help}>
              <div className="text-xs text-ink/65">{d.label}</div><div className="mt-1 text-xl font-semibold">{count}<span className="ml-2 text-xs font-normal text-ink/50">{Math.round(count / group.total * 100)}%</span></div>
            </div>; })}
          </div>
          {cohort === "new" && group.deadAtDiscovery > 0 && <p className="px-5 pt-4 text-xs text-ink/65">{group.deadAtDiscovery} already had a dead link when first discovered. This count is independent of the feedback filter.</p>}
          <details className="p-5">
            <summary className="cursor-pointer text-sm font-medium underline underline-offset-4">View {group.total} underlying roles</summary>
            <ul className="mt-4 divide-y divide-slate">
              {group.records.map(record => {
                const url = safeSourceUrl(record.source_url);
                const reason = FIT_REASONS.find(r => r.key === record.disposition_reason)?.label;
                return <li key={record.id} className="py-3 text-sm">
                  <div className="flex flex-wrap justify-between gap-2"><span className="font-medium">{record.company}: {record.role_title}</span><span>{dispositionLabel(record.disposition)}{reason ? ` (${reason})` : ""}</span></div>
                  <p className="mt-1 text-xs text-ink/60">{record.source_method || "Discovery method unknown"}; discovered {date(record.discovered_at)}. {record.occurred_at ? `${record.actor === "user" ? "You" : "The app"} updated ${date(record.occurred_at)}. ` : ""}Pipeline status: {record.status}.{record.job_id === null ? " Role removed from pipeline." : ""}</p>
                  {url ? <a href={url} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block text-xs underline underline-offset-4">Original source</a> : <p className="mt-2 text-xs text-ink/50">Original source unknown</p>}
                </li>;
              })}
            </ul>
          </details>
        </section>;
      })}
    </div>}
  </main>;
}
