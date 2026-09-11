"use client";

import { useEffect, useRef, useState } from "react";
import { getGradingPause, retryMissingGrades } from "@/app/actions/grading";
import type { Job } from "@/lib/types";
import type { JobStatusDef } from "@/lib/job-statuses";
import { requestWithDeadline } from "@/lib/client-request";

export default function GradeRecoveryPanel({ jobs, statuses, onUpdated }: {
  jobs: Job[]; statuses: JobStatusDef[]; onUpdated: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [paused, setPaused] = useState<string | null>(null);
  const stop = useRef(false);
  useEffect(() => {
    let active = true;
    getGradingPause().then(r => { if (active) setPaused(r.error ?? r.paused); })
      .catch(() => { if (active) setPaused("Could not check grading status. Reload to try again."); });
    return () => { active = false; stop.current = true; };
  }, []);
  const missing = jobs.filter(j => j.fit_score === null && !j.never_live && j.status !== "Posting Closed" &&
    !statuses.some(s => s.key === j.status && (s.bucket === "terminal" || s.hidden))).length;

  async function retry() {
    setBusy(true);
    stop.current = false;
    setNotice("Recovering missing grades…");
    let graded = 0;
    try {
      // Each RPC owns one durable claim. A lost connection cannot duplicate it.
      for (let batch = 0; batch < 25 && !stop.current; batch++) {
        const result = await requestWithDeadline(retryMissingGrades(batch === 0), 180_000);
        graded += result.graded;
        setNotice(`Recovered ${graded} grade${graded === 1 ? "" : "s"}.`);
        await requestWithDeadline(onUpdated(), 15_000);
        if (result.error !== undefined) { setNotice(`Recovered ${graded} grade${graded === 1 ? "" : "s"}. ${result.error}`); break; }
        if (result.attempted === 0) break;
      }
      const state = await requestWithDeadline(getGradingPause(), 15_000);
      setPaused(state.error ?? state.paused);
    } catch {
      setNotice(`Connection interrupted after ${graded} confirmed grades. Reload to see saved progress; automatic recovery will pick up unfinished work.`);
    } finally { setBusy(false); }
  }

  if (!missing && !notice && !paused) return null;
  return <div className="mb-6 rounded-lg border border-slate bg-white p-4 text-sm" role="status">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <p className="font-medium">{missing} open role{missing === 1 ? "" : "s"} waiting for grades</p>
        <p className="mt-1 text-ink/60">{paused || "Missing grades retry automatically during scheduled processing. Retry now to recover up to 25; normal API costs and spending limits apply."}</p>
      </div>
      <button onClick={() => busy ? (stop.current = true) : void retry()}
        className="rounded-md border border-slate px-3 py-2 font-medium hover:border-ink">
        {busy ? "Stop after this role" : "Retry missing grades"}
      </button>
    </div>
    {notice && <p className="mt-2 text-ink/70">{notice}</p>}
  </div>;
}
