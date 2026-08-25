"use client";

import { useState, useTransition } from "react";
import ResumeDocument from "@/components/resume/ResumeDocument";
import { tailorResumeForJob } from "@/app/actions/resume";
import type { CareerRecord, ResumeSelection } from "@/lib/resume-render/render";

export default function TailorPanel({
  career,
  jobId,
  initialSelection,
}: {
  career: CareerRecord;
  jobId: string;
  initialSelection: ResumeSelection | null;
}) {
  const [selection, setSelection] = useState(initialSelection);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function tailor() {
    setError(null);
    startTransition(async () => {
      const res = await tailorResumeForJob(jobId);
      if (res.error) setError(res.error);
      else setSelection(res.selection);
    });
  }

  function regenerate() {
    if (!window.confirm("Regenerate this tailored resume? The current version will be replaced.")) return;
    tailor();
  }

  if (!selection) {
    return (
      <div className="flex flex-col items-start gap-3">
        {error && <p className="text-sm text-[#92400E]">{error}</p>}
        <button
          onClick={tailor}
          disabled={isPending}
          className="rounded border border-slate px-3 py-1.5 text-sm hover:border-ink disabled:opacity-50"
        >
          {isPending ? "Tailoring…" : "Tailor for this job"}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {error && <p className="text-sm text-[#92400E]">{error}</p>}
      <div className="flex items-center gap-3">
        <button
          onClick={() => window.print()}
          className="rounded border border-slate px-3 py-1.5 text-sm hover:border-ink"
        >
          Print / Export PDF
        </button>
        <button
          onClick={regenerate}
          disabled={isPending}
          className="rounded border border-slate px-3 py-1.5 text-sm hover:border-ink disabled:opacity-50"
        >
          {isPending ? "Regenerating…" : "Regenerate"}
        </button>
      </div>
      <ResumeDocument career={career} selection={selection} />
    </div>
  );
}
