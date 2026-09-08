"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import ResumeDocument from "@/components/resume/ResumeDocument";
import CoveragePanel from "@/components/resume/CoveragePanel";
import ChatPanel from "@/components/resume/ChatPanel";
import { captureResumeHtml } from "@/components/resume/useResumeCapture";
import { tailorResumeForJob, type ResumeOverrides } from "@/app/actions/resume";
import { saveResume } from "@/app/actions/saved-resumes";
import type { CareerRecord, ResumeSelection } from "@/lib/resume-render/render";
import type { CoverageReport } from "@/lib/resume-coverage";
import { styleAttributeFor } from "@/lib/resume-design-tokens";
import { UNDESCRIBED_DB_ERROR } from "@/lib/write-failure";

export default function TailorPanel({
  career: initialCareer,
  jobId,
  initialSelection,
  initialOverrides,
  initialCoverage,
  initialWarnings,
  roleTitle,
  company,
}: {
  career: CareerRecord;
  jobId: string;
  initialSelection: ResumeSelection | null;
  initialOverrides: ResumeOverrides;
  initialCoverage: CoverageReport | null;
  initialWarnings: string[];
  /**
   * Snapshotted onto the saved row so the archive card survives the job being
   * deleted. null when the page could not read the job — Save is withheld
   * rather than writing a row with no identity, since "" would satisfy the
   * NOT NULL columns while defeating the reason they exist.
   */
  roleTitle: string | null;
  company: string | null;
}) {
  const [career, setCareer] = useState(initialCareer);
  const [selection, setSelection] = useState(initialSelection);
  const [overrides, setOverrides] = useState(initialOverrides);
  const [coverage, setCoverage] = useState(initialCoverage);
  const [warnings, setWarnings] = useState(initialWarnings);
  const [error, setError] = useState<string | null>(null);
  const [unread, setUnread] = useState(false);
  const [isPending, startTransition] = useTransition();

  // Validated once here, never hand-assembled: TOKEN_STYLE_RULES matching is
  // case-sensitive and untrimmed, so a hand-built declaration string fails
  // CLOSED with no error anywhere. styleAttributeFor is the one place that
  // normalises and validates a design override into a style string.
  const rootStyle = useMemo(() => styleAttributeFor(overrides.design || {}), [overrides.design]);

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
      else {
        setSelection(res.selection);
        if (res.career) setCareer(res.career);
        // Regenerate discards overrides — reflect that reset rather than
        // keeping a design/text override the just-saved row no longer carries.
        setOverrides(res.overrides);
        setCoverage(res.coverage);
        setWarnings(res.warnings);
        // A warning, never a refusal. The user can read the posting in a
        // browser; withholding the document helps nobody. But a résumé tailored
        // from a job TITLE, with no posting behind it, must not look identical
        // to one tailored from what the employer actually asked for.
        setUnread(res.unread === true);
      }
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
        // captureResumeHtml only reads docPageEl.innerHTML; the margin is an
        // attribute on docPageEl itself, so it must be sent separately or a
        // chat-set margin silently reverts to 0.68in on the saved screen.
        pageMargin: overrides.pageMargin,
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
    // The non-dirty wording used to say only "the current version will be
    // replaced" — true, but it badly understates things once a user has
    // spent ten chat turns tuning bullet choices, text edits and design
    // tokens: Regenerate re-derives themes from the posting from scratch and
    // discards ALL of that, dirty or not.
    const warning = dirty
      ? "You have unsaved edits. Regenerate and discard them?"
      : "Regenerate this resume? It re-derives themes from the posting and discards every " +
        "change made in the chat — bullet choices, text edits and design changes.";
    if (!window.confirm(warning)) return;
    tailor();
  }

  // The one place a chat turn reaches TailorPanel's own state. Only ChatPanel
  // decides WHEN to call this (a turn whose `applied` is non-empty) — this
  // just mirrors resume.ts's tailor() success path and marks the document
  // dirty, since the change has not gone through Save yet.
  function onChatApplied(next: {
    selection: ResumeSelection;
    overrides: ResumeOverrides;
    coverage: CoverageReport;
  }) {
    setSelection(next.selection);
    setOverrides(next.overrides);
    setCoverage(next.coverage);
    setDirty(true);
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
      {unread && (
        /* Says what the document was built from, because a résumé tailored to a
           job TITLE must not look identical to one tailored to what the
           employer actually asked for. print:hidden — it is a note to the user,
           not part of the document. */
        <p className="text-xs text-ink/60 print:hidden">
          No job description has been read for this role, so these themes come from the
          title and this app&apos;s own summary — not from what the posting asks for. Add
          the posting by URL on Roles, or paste it there, then tailor again.
        </p>
      )}
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
      {coverage && <CoveragePanel coverage={coverage} warnings={warnings} />}
      <ChatPanel jobId={jobId} dirty={dirty} onApplied={onChatApplied} />
      <ResumeDocument
        career={career}
        selection={selection}
        docPageRef={docPageRef}
        onEdit={() => setDirty(true)}
        rootStyle={rootStyle}
        pageMargin={overrides.pageMargin}
      />
    </div>
  );
}
