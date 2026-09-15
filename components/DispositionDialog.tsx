"use client";

import { useEffect, useRef, useState } from "react";
import { FIT_REASONS, type FitReason } from "@/lib/job-dispositions";

export default function DispositionDialog({ count, initialReason = null, saving, error, onSave, onClose }: {
  count: number; saving: boolean; error: string | null;
  initialReason?: FitReason | null;
  onSave: (reason: FitReason | null) => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState<FitReason | "">(initialReason ?? "");
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} onCancel={e => { e.preventDefault(); if (!saving) onClose(); }} aria-labelledby="disposition-title"
    className="w-[calc(100%-2rem)] max-w-md rounded-xl border border-slate bg-white p-6 text-ink shadow-xl backdrop:bg-black/30">
    <form onSubmit={e => { e.preventDefault(); onSave(reason || null); }}>
      <h2 id="disposition-title" className="font-heading text-xl font-semibold">Not a fit</h2>
      <p className="mt-2 text-sm text-ink/70">File {count === 1 ? "this role" : `these ${count} roles`} out of your active pipeline. An optional reason helps explain which sources match your search.</p>
      <label className="mt-5 block text-sm font-medium" htmlFor="fit-reason">Reason (optional)</label>
      <select id="fit-reason" value={reason} disabled={saving} onChange={e => setReason(e.target.value as FitReason | "")}
        className="mt-2 w-full rounded-md border border-slate bg-white p-2 text-sm focus:outline-ink">
        <option value="">No reason</option>
        {FIT_REASONS.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
      </select>
      {error !== null && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
      <div className="mt-6 flex justify-end gap-3">
        <button type="button" disabled={saving} onClick={onClose} className="rounded-md border border-slate px-4 py-2 text-sm disabled:opacity-50">Cancel</button>
        <button type="submit" disabled={saving} className="rounded-md bg-ink px-4 py-2 text-sm text-white disabled:opacity-50">{saving ? "Saving…" : "Save disposition"}</button>
      </div>
    </form>
  </dialog>;
}
