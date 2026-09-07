"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import ResumeDocument from "@/components/resume/ResumeDocument";
import { captureResumeHtml } from "@/components/resume/useResumeCapture";
import { tailorResumeForJob } from "@/app/actions/resume";
import { saveResume } from "@/app/actions/saved-resumes";
import type { CareerRecord, ResumeSelection } from "@/lib/resume-render/render";
import { UNDESCRIBED_DB_ERROR } from "@/lib/write-failure";

export default function TailorPanel({
  career,
  jobId,
  initialSelection,
  roleTitle,
  company,
}: {
  career: CareerRecord;
  jobId: string;
  initialSelection: ResumeSelection | null;
  /**
   * Snapshotted onto the saved row so the archive card survives the job being
   * deleted. null when the page could not read the job — Save is withheld
   * rather than writing a row with no identity, since "" would satisfy the
   * NOT NULL columns while defeating the reason they exist.
   */
  roleTitle: string | null;
  company: string | null;
}) {
  const [selection, setSelection] = useState(initialSelection);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const docPageRef = useRef<HTMLElement>(null);
  const [dirty, setDirty] = useState(false);
  const [label, setLabel] = useState("");
  const [saved, setSaved] = useState<{ id: string } | null>(null);
  const canSave = roleTitle !== null && company !== null;

  // beforeunload covers tab close and external navigation ONLY. It does not
  // fire for Regenerate (a React state change that re-sets
  // dangerouslySetInnerHTML) or for window.print() — Regenerate gets its own
  // confirm below.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  function tailor() {
    setError(null);
    startTransition(async () => {
      const res = await tailorResumeForJob(jobId);
      // Presence, not truthiness: res.error can legitimately be "" on a
      // database failure (describeWriteFailure substitutes UNDESCRIBED_DB_ERROR
      // only where it's shown), and "" is falsy — a truthiness check would fall
      // into the else branch and try to render a null selection as success.
      if (res.error !== undefined) setError(res.error || UNDESCRIBED_DB_ERROR);
      else setSelection(res.selection);
    });
  }

  function save(allowDuplicate = false) {
    const el = docPageRef.current;
    if (!el || !canSave) return;
    setError(null);
    const html = captureResumeHtml(el);
    startTransition(async () => {
      const res = await saveResume({
        jobId,
        html,
        roleTitle: roleTitle as string,
        company: company as string,
        label: label.trim() ? label.trim() : null,
        allowDuplicate,
      });
      if (res.error !== undefined) {
        setError(res.error || UNDESCRIBED_DB_ERROR);
      } else if (res.duplicateOf) {
        if (window.confirm("This is identical to the version you already saved. Save anyway?")) {
          save(true);
        }
      } else {
        setDirty(false);
        setSaved({ id: res.id as string });
      }
    });
  }

  function regenerate() {
    // Regenerate is not a navigation, so beforeunload never fires for it.
    const warning = dirty
      ? "You have unsaved edits. Regenerate and discard them?"
      : "Regenerate this tailored resume? The current version will be replaced.";
    if (!window.confirm(warning)) return;
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
      {error && <p className="text-sm text-[#92400E] print:hidden">{error}</p>}
      <div className="flex flex-wrap items-center gap-3 print:hidden">
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
        {canSave && (
          <>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Label (optional)"
              className="rounded border border-slate px-2 py-1.5 text-sm"
            />
            <button
              onClick={() => save()}
              disabled={isPending}
              className="rounded border border-slate px-3 py-1.5 text-sm hover:border-ink disabled:opacity-50"
            >
              {isPending ? "Saving…" : "Save"}
            </button>
          </>
        )}
        {dirty && <span className="text-xs text-[#92400E]">Unsaved edits</span>}
        {saved && (
          <a href={`/resume?savedId=${saved.id}`} className="text-xs underline underline-offset-2">
            Saved — view it
          </a>
        )}
        <span className="text-xs text-ink/50">
          Click any text below to edit it directly — for Google Docs, select all and copy/paste after editing.
        </span>
      </div>
      <ResumeDocument
        career={career}
        selection={selection}
        docPageRef={docPageRef}
        onEdit={() => setDirty(true)}
      />
    </div>
  );
}
