"use client";
import {useState, useRef, useEffect} from "react";
import {restoreTrackedCompany, checkCompanyNow} from "@/app/actions/watchlist";
import {removalReasonLabel, type RestoreNotice} from "@/lib/watchlist-removal";
import {describeWriteFailure} from "@/lib/write-failure";

export default function RestoreCompanyReview({notice, onCancel, onRestored, onBusyChange}: {
  notice: RestoreNotice; onCancel: () => void; onRestored: (message: string) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [current, setCurrent] = useState(notice);
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState(notice.careersUrl ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {panel.current?.focus({preventScroll:true}); panel.current?.scrollIntoView({block:"start"});}, []);
  async function restore() {
    setBusy(true); onBusyChange?.(true); setError(null);
    try {
      const result = await restoreTrackedCompany(current.company, current.acknowledgementKey, editing ? url : undefined);
      if (result.restore) { setCurrent(result.restore); setUrl(result.restore.careersUrl ?? ""); }
      const failure = describeWriteFailure(result.error, "restore this company");
      if (failure !== undefined || result.restore) {setError(failure ?? "Review this company's updated removal before restoring."); return;}
      let message = `${current.company} restored. Automatic checks resume; automatic paid web search is off.`;
      if (editing) {
        const check = await checkCompanyNow(current.company);
        message += check.error ? ` Check result: ${check.error}` : ` Check finished: ${check.rolesFound} roles found, ${check.newRoles} new.`;
      }
      onRestored(message);
    } catch { setError("Could not confirm the restore or check completed. Refresh your watchlist before trying again."); }
    finally {setBusy(false); onBusyChange?.(false);}
  }
  return <section ref={panel} tabIndex={-1} className="my-4 scroll-mt-32 border-y border-slate bg-white p-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink" aria-label={`Restore ${current.company}`}>
    <h3 className="text-base font-semibold">You previously stopped tracking {current.company}</h3>
    <p className="mt-1 text-sm text-ink/70">{removalReasonLabel(current.reason)}{current.removedAt ? ` · ${new Date(current.removedAt).toLocaleDateString()}` : " · Removal date was not recorded"}</p>
    <p className="mt-2 max-w-prose text-sm text-ink/70">Restoring resumes automatic checks. Saved roles and history stay available. Automatic paid web search stays off.</p>
    {editing && <label className="mt-3 block max-w-xl text-sm">Careers page URL
      <input type="url" value={url} onChange={event => setUrl(event.target.value)} disabled={busy} className="mt-1 block w-full rounded-md border border-slate px-3 py-2" placeholder="https://company.com/careers" />
      <span className="mt-1 block text-xs text-ink/70">Checks this page directly after restoring. No paid web search. AI processing may use your spending allowance.</span>
    </label>}
    {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
    <div className="mt-4 flex flex-wrap gap-2">
      <button type="button" disabled={busy || (editing && !url.trim())} onClick={() => void restore()} className="rounded-md bg-ink px-3 py-2 text-sm font-medium text-white disabled:opacity-50">{busy ? "Restoring…" : editing ? "Restore and check page" : "Restore"}</button>
      {!editing && <button type="button" disabled={busy} onClick={() => setEditing(true)} className="rounded-md border border-slate px-3 py-2 text-sm">Update careers page…</button>}
      <button type="button" disabled={busy} onClick={onCancel} className="rounded-md border border-slate px-3 py-2 text-sm">Keep removed</button>
    </div>
  </section>;
}
