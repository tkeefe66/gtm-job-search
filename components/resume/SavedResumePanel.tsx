"use client";

import Link from "next/link";
import Script from "next/script";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { captureResumeHtml } from "@/components/resume/useResumeCapture";
import {
  deleteSavedResume,
  getDownloadAssets,
  saveResumeAsNewVersion,
} from "@/app/actions/saved-resumes";
import { restoreSavedVersion } from "@/app/actions/restore-saved-version";
import {
  DEFAULT_PAGE_MARGIN,
  DESIGN_VERSION,
  buildDownloadHtml,
  downloadFilename,
} from "@/lib/resume-download";
import { daysUntil } from "@/lib/saved-resume-grouping";
import { savedEditAffordance } from "@/lib/saved-edit-affordance";
import { chatSendPlan } from "@/lib/chat-launch";
import { stashPendingMessage } from "@/lib/pending-chat-message";
import ChatDock from "@/components/resume/ChatDock";
import SavedChatLauncher from "@/components/resume/SavedChatLauncher";
import { UNDESCRIBED_DB_ERROR } from "@/lib/write-failure";
import type { SavedResume } from "@/lib/types";

/**
 * The two warnings the spec requires, in substance, plus the checkpoint
 * notice — shown before restoreSavedVersion runs. Extended below with a
 * third sentence when this panel's own contentEditable document carries
 * uncaptured edits (see `dirty`), since navigating away discards those too.
 */
const UNSAVED_HERE_CONFIRM =
  "You have edits here that were never saved to this version. Opening the editor discards " +
  "them — they exist only on this page. Continue?";

/** Shown beside the button rather than in a dialog: it is context for a
 *  decision, not a warning about a destructive act. The restore checkpoints the
 *  current draft, so it is undoable. */
const RESTORE_NOTE =
  "Rebuilds this résumé from the choices that produced it, against your current career " +
  "record, so it may differ from what you see here. Your current draft is checkpointed first."

/**
 * A frozen saved résumé, mounted as stored.
 *
 * Deliberately NOT rendered through renderBody: this row is a document, not a
 * selection. Re-rendering it would silently apply today's career record and
 * today's bullet-selection rules to something the user saved as final.
 */
export default function SavedResumePanel({ resume }: { resume: SavedResume }) {
  const router = useRouter();
  const docPageRef = useRef<HTMLElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  // Mirrors ResumeDocument's onInput contract: set on the first and every
  // subsequent edit to this row's contentEditable doc-page, never captured
  // into React state on its own. Only Save (as new version) reads the DOM;
  // this flag exists solely to warn before a navigation would discard it.
  const [dirty, setDirty] = useState(false);

  const days = daysUntil(resume.expiresAt, Date.now());
  const stale = resume.designVersion !== DESIGN_VERSION;
  const affordance = savedEditAffordance({ hasContent: resume.hasContent, jobId: resume.jobId });

  function saveAsNew() {
    const el = docPageRef.current;
    if (!el) return;
    setError(null);
    const html = captureResumeHtml(el);
    startTransition(async () => {
      // Never an overwrite of the opened row: this writes a NEW row, which is
      // what "frozen" means. saveResumeAsNewVersion reads job_id, role_title,
      // company and content off the SOURCE row itself (this.resume.id) — never
      // the working draft, and refuses if the source's job was untracked, so
      // jobId/roleTitle/company are not sent from here at all.
      const res = await saveResumeAsNewVersion({
        fromSavedId: resume.id,
        html,
        label: resume.label,
        // Carries the margin forward: a new version of a document that had a
        // non-default margin should not silently revert to 0.68in.
        pageMargin: resume.pageMargin,
      });
      if (res.error !== undefined) setError(res.error || UNDESCRIBED_DB_ERROR);
      else if (res.duplicateOf) {
        setError("That is identical to the version you are viewing — nothing new was saved.");
      } else router.push(`/resume?savedId=${res.id}`);
    });
  }

  /** The chat dock's send handler. A saved row is frozen HTML with no
   *  selection, so the first message has to restore it into the working draft
   *  first — chatSendPlan decides that, and editThisVersion carries the
   *  message across the navigation. */
  function sendFromSaved(text: string) {
    const plan = chatSendPlan({
      context: "saved",
      hasContent: resume.hasContent,
      jobId: resume.jobId,
    });
    if (plan.kind === "blocked") {
      setError(plan.note);
      return;
    }
    if (plan.kind === "restoreThenSend") {
      // Stashed BEFORE the confirm: if the user cancels, the stash is harmless
      // (nothing navigates, and the next take clears it), whereas stashing
      // after an await would race the navigation editThisVersion performs.
      stashPendingMessage(window.sessionStorage, plan.jobId, text);
      editThisVersion();
    }
  }

  function editThisVersion() {
    // Confirms ONLY when something is genuinely unrecoverable. The restore
    // itself is not: the current draft is checkpointed into the archive first,
    // which is the entire reason that mechanism exists — warning about a
    // reversible action trains the user to click through warnings that matter.
    // Uncaptured typing in THIS page's contentEditable document is the one
    // exception: it lives nowhere but the DOM, and no checkpoint preserves it.
    // What the old blanket confirm explained now sits next to the button and in
    // the chat dock, where it can be read before the decision instead of during.
    if (dirty && !window.confirm(UNSAVED_HERE_CONFIRM)) return;
    setError(null);
    startTransition(async () => {
      const res = await restoreSavedVersion(resume.id);
      // Presence, not truthiness: res.error can legitimately be "".
      if (res.error !== undefined) {
        setError(res.error || UNDESCRIBED_DB_ERROR);
        return;
      }
      // markerSaveError is NOT a failure — the checkpoint and the restore
      // itself already committed. Only a separate write (a marker turn in
      // the chat thread) failed, and this panel is about to unmount on
      // navigation regardless, so there is nowhere durable to show a notice.
      // Never treated as `error` and never blocks the navigate below — see
      // RestoreSavedVersionResult.markerSaveError.
      if (res.jobId) router.push(`/resume?jobId=${res.jobId}`);
    });
  }

  function download() {
    setError(null);
    startTransition(async () => {
      const assets = await getDownloadAssets();
      if (assets.error !== undefined) {
        setError(assets.error || "Could not assemble the download.");
        return;
      }
      const file = buildDownloadHtml({
        markup: resume.html,
        css: assets.css,
        docPageJs: assets.docPageJs,
        title: `Résumé — ${resume.roleTitle} at ${resume.company}`,
        pageMargin: resume.pageMargin,
      });
      const url = URL.createObjectURL(new Blob([file], { type: "text/html" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = downloadFilename(resume.roleTitle, resume.company, resume.createdAt);
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });
  }

  function remove() {
    if (!window.confirm("Delete this saved résumé? This cannot be undone.")) return;
    setError(null);
    startTransition(async () => {
      const res = await deleteSavedResume(resume.id);
      if (res.error !== undefined) setError(res.error || UNDESCRIBED_DB_ERROR);
      else router.push("/resume");
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {error && <p className="text-sm text-[#92400E] print:hidden">{error}</p>}

      <p className="text-xs text-ink/60 print:hidden">
        {resume.roleTitle} at {resume.company} · saved{" "}
        {new Date(resume.createdAt).toLocaleDateString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
        })}
        {resume.label ? ` · ${resume.label}` : ""} ·{" "}
        <span className={days < 7 ? "text-[#92400E]" : undefined}>
          expires in {days} {days === 1 ? "day" : "days"}
        </span>
        {stale && " · saved against an earlier document design"}
      </p>

      <div className="flex flex-wrap items-center gap-3 print:hidden">
        <button
          onClick={() => window.print()}
          className="rounded border border-slate px-3 py-1.5 text-sm hover:border-ink"
        >
          Print / Export PDF
        </button>
        <button
          onClick={download}
          disabled={isPending}
          className="rounded border border-slate px-3 py-1.5 text-sm hover:border-ink disabled:opacity-50"
        >
          Download
        </button>
        <button
          onClick={saveAsNew}
          disabled={isPending}
          className="rounded border border-slate px-3 py-1.5 text-sm hover:border-ink disabled:opacity-50"
        >
          {isPending ? "Saving…" : "Save as new version"}
        </button>
        {affordance.kind === "restore" && (
          <span className="flex items-center gap-2">
            <button
              onClick={editThisVersion}
              disabled={isPending}
              className="rounded border border-slate px-3 py-1.5 text-sm hover:border-ink disabled:opacity-50"
            >
              {isPending ? "Restoring…" : "Edit this version →"}
            </button>
            <span className="max-w-md text-xs text-ink/50">{RESTORE_NOTE}</span>
          </span>
        )}
        {affordance.kind === "draftOnly" && (
          <span className="flex items-center gap-2 text-xs text-ink/60">
            <Link
              href={`/resume?jobId=${resume.jobId}`}
              className="text-sm underline underline-offset-2"
            >
              {/* NOT "Edit this version" — this row predates migration 021 and has
                  no stored selection, so there is nothing of THIS version to
                  reopen. The link goes to the current draft, which may be a
                  different document entirely; the note beside it says so, but the
                  label is what gets read first. */}
              Open the current draft →
            </Link>
            {affordance.note}
          </span>
        )}
        {affordance.kind === "unavailable" && (
          <span className="text-xs text-ink/50">{affordance.note}</span>
        )}
        <button
          onClick={remove}
          disabled={isPending}
          className="text-sm text-ink/60 underline underline-offset-2 hover:text-ink disabled:opacity-50"
        >
          Delete
        </button>
        <Link href="/resume" className="text-sm underline underline-offset-2">
          All saved résumés
        </Link>
      </div>

      {/* Collapsed by default here, unlike the tailor screen: the document is
          what you came to this page to read. */}
      <ChatDock title="Chat about this résumé">
        <SavedChatLauncher
          onSend={sendFromSaved}
          blockedNote={affordance.kind === "restore" ? undefined : affordance.note}
          isPending={isPending}
        />
      </ChatDock>

      <Script src="/resume-design/doc-page.js" strategy="afterInteractive" />
      <Script src="/resume-design/rsm-page-guides.js" strategy="afterInteractive" />
      <style>{`
        doc-page:not(:defined) { visibility: hidden; }
        doc-page[contenteditable] { outline: none; cursor: text; }
      `}</style>
      <doc-page
        ref={docPageRef as React.RefObject<HTMLElement>}
        margin={resume.pageMargin || DEFAULT_PAGE_MARGIN}
        contentEditable
        suppressContentEditableWarning
        onInput={() => setDirty(true)}
        dangerouslySetInnerHTML={{ __html: resume.html }}
      />
    </div>
  );
}
