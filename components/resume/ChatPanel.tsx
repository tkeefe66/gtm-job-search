"use client";

import { useEffect, useState, useTransition } from "react";
import {
  sendChatTurn,
  loadChatThread,
  acceptProposedBullets,
  type StoredChatMessage,
} from "@/app/actions/resume-chat";
import type { ResumeOverrides } from "@/app/actions/resume";
import type { CareerRecord, ResumeSelection } from "@/lib/resume-render/render";
import type { CoverageReport } from "@/lib/resume-coverage";
import { UNDESCRIBED_DB_ERROR } from "@/lib/write-failure";

const DIRTY_CONFIRM =
  "You have unsaved edits to this document. Apply this change and discard them?";

// summary edits are ARCHITECTURALLY forced onto every positioning variant —
// effectiveCareer runs before selectBullets picks a variant, so a set_text on
// "summary" cannot help but overwrite what every variant would otherwise show.
// Not a bug, but a surprise, so it is surfaced once per turn that causes it.
const SUMMARY_FLATTEN_NOTE =
  "That rewrote the summary on every positioning variant — bullet selection differs by variant, but the summary text does not.";

interface TurnMeta {
  applied: string[];
  rejected?: string;
  summaryFlattened: boolean;
}

interface AppliedDocument {
  career: CareerRecord;
  selection: ResumeSelection;
  overrides: ResumeOverrides;
  coverage: CoverageReport;
}

/**
 * The conversational half of the tailor screen. Renders beneath
 * CoveragePanel inside TailorPanel, and never touches career/selection state
 * directly — every change it makes reaches the document through `onApplied`,
 * which TailorPanel wires to its own setSelection/setOverrides/setCoverage.
 *
 * Two things this component deliberately does NOT do:
 *   - persist per-message "was this rejected / what did it change" metadata.
 *     That only exists for turns sent in THIS session (`turnMeta`, keyed by
 *     message index) — a reloaded thread (loadChatThread) shows prose only,
 *     because sendChatTurn's TurnResult, not the stored message, is where
 *     `applied`/`rejected` live.
 *   - decide FOR ITSELF whether a turn changed the document before sending
 *     it. See `send()` below for why the dirty guard fires on every turn
 *     while `dirty` is true, not only on turns predicted to mutate.
 */
export default function ChatPanel({
  jobId,
  dirty,
  onApplied,
}: {
  jobId: string;
  /** Mirrors TailorPanel's own `dirty` state. A chat turn re-renders the
   *  document from React state, and ResumeDocument.tsx:68-73 is explicit that
   *  re-setting dangerouslySetInnerHTML discards unsaved hand edits — this is
   *  the one thing standing between that and a silent loss. */
  dirty: boolean;
  /** Fires only when a turn actually changed the document
   *  (`res.changedDocument`, decided in lib/resume-ops.ts). A pure question —
   *  or a turn whose only operation was a rule-change request or a bullet
   *  proposal — must not reach this: it would mark the document dirty and
   *  re-render it, discarding the user's unsaved hand edits, for a turn that
   *  changed nothing. `applied.length > 0` is NOT that signal; it counts
   *  operations, not changes. */
  onApplied: (next: AppliedDocument) => void;
}) {
  const [messages, setMessages] = useState<StoredChatMessage[]>([]);
  const [turnMeta, setTurnMeta] = useState<Record<number, TurnMeta>>({});
  const [input, setInput] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [transcriptNote, setTranscriptNote] = useState<string | null>(null);
  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await loadChatThread(jobId);
      if (cancelled) return;
      // Presence, not truthiness — res.error can legitimately be "".
      if (res.error !== undefined) setLoadError(res.error || UNDESCRIBED_DB_ERROR);
      else setMessages(res.messages);
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  function send() {
    const text = input.trim();
    if (!text || isPending) return;

    // The guard runs BEFORE we know whether this turn will change anything —
    // a question and a mutating request are indistinguishable until the model
    // answers, and by the time an answer carries `applied`, ResumeDocument
    // has already re-rendered from whatever new selection/overrides came
    // back, discarding a hand edit with no chance to warn first. So this
    // prompts on every turn while `dirty` is true, not only on turns guessed
    // to mutate — the honest signal (`applied.length > 0`) exists only AFTER
    // the risk has already passed.
    if (dirty && !window.confirm(DIRTY_CONFIRM)) return;

    setError(null);
    setTranscriptNote(null);
    startTransition(async () => {
      const res = await sendChatTurn(jobId, text);
      setMessages(res.messages);

      // Presence, not truthiness — res.error can legitimately be "".
      if (res.error !== undefined) {
        setError(res.error || UNDESCRIBED_DB_ERROR);
      } else {
        setInput("");
      }

      // A SEPARATE field from `error`: the change already applied and saved,
      // only the transcript entry may not survive a reload. Shown as a note,
      // not a warning, and worded so retrying reads as unnecessary rather
      // than as the fix — resending would duplicate an already-applied
      // add_bullet or propose_career_bullet.
      if (res.transcriptSaveError !== undefined) {
        setTranscriptNote(
          "That change was applied and saved to the document. This message may not still " +
            "be here after a reload, but there's nothing to redo — no need to send it again."
        );
      }

      const lastIndex = res.messages.length - 1;
      if (lastIndex >= 0 && res.messages[lastIndex].role === "assistant") {
        setTurnMeta((prev) => ({
          ...prev,
          [lastIndex]: {
            applied: res.applied,
            rejected: res.rejected,
            summaryFlattened: res.applied.indexOf("edited text: summary") !== -1,
          },
        }));
      }

      // The honest "did this turn change the document" signal, decided
      // server-side in lib/resume-ops.ts. A rejected or errored turn always
      // returns `changedDocument: false`, so this can never fire for either —
      // nothing on screen changes for those, matching requirement 3 — and
      // neither does a turn whose only operations were a rule-change request
      // or a bullet proposal.
      if (res.changedDocument && res.career && res.selection && res.coverage) {
        onApplied({
          career: res.career,
          selection: res.selection,
          overrides: res.overrides,
          coverage: res.coverage,
        });
      }
    });
  }

  function accept(messageIndex: number, id: string) {
    setError(null);
    setAcceptingId(id);
    startTransition(async () => {
      const res = await acceptProposedBullets(jobId, [id]);
      setAcceptingId(null);
      // Presence, not truthiness — res.error can legitimately be "".
      if (res.error !== undefined) {
        setError(res.error || UNDESCRIBED_DB_ERROR);
        return;
      }
      // The accepted bullet is placed on the page, not merely filed in the
      // career record — otherwise Accept removes a button and changes nothing
      // else, on screen or after a reload. The action returns the same shape
      // a chat turn does, so it lands through the same path.
      if (res.career && res.selection && res.overrides && res.coverage) {
        onApplied({
          career: res.career,
          selection: res.selection,
          overrides: res.overrides,
          coverage: res.coverage,
        });
      }
      // Accepted bullets land in the career overlay, not on this thread.
      // Drop the id from this message's proposals so the button it belonged
      // to disappears — acceptProposedBullets is idempotent, but there is
      // nothing left here worth clicking twice for.
      setMessages((prev) =>
        prev.map((m, i) =>
          i === messageIndex && m.proposals
            ? { ...m, proposals: m.proposals.filter((p) => p.id !== id) }
            : m
        )
      );
    });
  }

  return (
    <div className="flex flex-col gap-3 border-t border-slate pt-4 print:hidden">
      <p className="text-xs font-medium uppercase tracking-wide text-ink/60">
        Chat about this résumé
      </p>

      {loadError && <p className="text-sm text-[#92400E]">{loadError}</p>}

      {messages.length > 0 && (
        <div className="flex flex-col gap-3">
          {messages.map((m, i) => {
            const meta = turnMeta[i];
            return (
              <div
                key={i}
                className={
                  m.role === "user"
                    ? "self-end max-w-[85%] rounded bg-ink/5 px-3 py-2"
                    : "max-w-[85%] rounded border border-slate px-3 py-2"
                }
              >
                <p className="whitespace-pre-wrap text-sm">{m.text}</p>

                {m.role === "assistant" && meta?.rejected && (
                  <p className="mt-1 text-xs text-[#92400E]">{meta.rejected}</p>
                )}

                {m.role === "assistant" && !meta?.rejected && meta && meta.applied.length > 0 && (
                  <ul className="mt-1 list-disc pl-4 text-xs text-ink/60">
                    {meta.applied.map((a, j) => (
                      <li key={j}>{a}</li>
                    ))}
                  </ul>
                )}

                {m.role === "assistant" && m.ruleRequests && m.ruleRequests.length > 0 && (
                  /* Persisted on the message, so it survives a reload — the
                     whole point of request_rule_change is a record someone
                     can act on later. */
                  <ul className="mt-1 list-disc pl-4 text-xs text-ink/60">
                    {m.ruleRequests.map((r, j) => (
                      <li key={j}>Rule change requested: {r}</li>
                    ))}
                  </ul>
                )}

                {m.role === "assistant" && meta?.summaryFlattened && (
                  <p className="mt-1 text-xs italic text-ink/60">{SUMMARY_FLATTEN_NOTE}</p>
                )}

                {m.role === "assistant" && m.proposals && m.proposals.length > 0 && (
                  <div className="mt-2 flex flex-col gap-2">
                    {m.proposals.map((p) => (
                      <div key={p.id} className="rounded border border-slate/60 px-2 py-1.5">
                        <p className="text-xs">{p.text}</p>
                        <button
                          onClick={() => accept(i, p.id)}
                          disabled={isPending}
                          className="mt-1 rounded border border-slate px-2 py-1 text-xs hover:border-ink disabled:opacity-50"
                        >
                          {acceptingId === p.id ? "Adding…" : "Accept into career record"}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {error && <p className="text-sm text-[#92400E]">{error}</p>}
      {transcriptNote && <p className="text-xs text-ink/60">{transcriptNote}</p>}

      <div className="flex items-center gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Ask for a change, e.g. “lead with the systems work”"
          disabled={isPending}
          className="flex-1 rounded border border-slate px-3 py-1.5 text-sm"
        />
        <button
          onClick={send}
          disabled={isPending || input.trim() === ""}
          className="rounded border border-slate px-3 py-1.5 text-sm hover:border-ink disabled:opacity-50"
        >
          {isPending ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
}
