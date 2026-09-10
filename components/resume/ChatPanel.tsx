"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import {
  sendChatTurn,
  loadChatThread,
  acceptProposedBullets,
  type StoredChatMessage,
} from "@/app/actions/resume-chat";
import type { ResumeOverrides } from "@/app/actions/resume";
import type { CareerRecord, ResumeSelection } from "@/lib/resume-render/render";
import type { CoverageReport } from "@/lib/resume-coverage";
import ChatComposer, { ChatWelcome } from "./ChatComposer";
import styles from "./chat.module.css";
import { UNDESCRIBED_DB_ERROR } from "@/lib/write-failure";

const DIRTY_CONFIRM =
  "You have unsaved edits to this document. Apply this change and discard them?";

// Deliberately different wording from DIRTY_CONFIRM: by the time this is
// asked, the bullet is already accepted and placed, so the only thing at
// stake is whether the document on screen is redrawn from it.
const ACCEPT_DIRTY_CONFIRM =
  "That bullet was added. Showing it means redrawing the document and discarding your unsaved edits. Redraw it now?";

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
  pendingMessage,
}: {
  jobId: string;
  /** Mirrors TailorPanel's own `dirty` state. A chat turn re-renders the
   *  document from React state, and ResumeDocument.tsx:80-83 is explicit that
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
  /** A message typed on the saved-résumé screen and carried across the restore
   *  navigation. Sent ONCE, on mount. The `sentPending` ref rather than a state
   *  flag because an effect that re-runs would re-send it — a second billed
   *  turn that edits the document again. */
  pendingMessage?: string | null;
}) {
  const [messages, setMessages] = useState<StoredChatMessage[]>([]);
  const [turnMeta, setTurnMeta] = useState<Record<number, TurnMeta>>({});
  const [input, setInput] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [transcriptNote, setTranscriptNote] = useState<string | null>(null);
  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const sentPending = useRef(false);
  const [loading, setLoading] = useState(true);
  const [sendingText, setSendingText] = useState<string | null>(null);
  const scrollArea = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const turnStarted = useRef(false);
  const busy = isPending || sendingText !== null || acceptingId !== null;

  useEffect(() => {
    if (followLatest.current && scrollArea.current) {
      scrollArea.current.scrollTop = scrollArea.current.scrollHeight;
    }
  }, [messages, sendingText, error, loading]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await loadChatThread(jobId);
      if (cancelled) return;
      setLoading(false);
      if (turnStarted.current) return;
      // Presence, not truthiness — res.error can legitimately be "".
      if (res.error !== undefined) setLoadError(res.error || UNDESCRIBED_DB_ERROR);
      else setMessages(res.messages);
    })().catch(() => {
      if (!cancelled) {
        setLoading(false);
        setLoadError("Could not load this conversation. Refresh the page to try again.");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  // Fire the carried message exactly once. Guarded by a ref, not by state or by
  // the dependency array: a re-render that re-ran this would send a second
  // billed turn and apply the same edit twice.
  useEffect(() => {
    if (!pendingMessage || sentPending.current) return;
    sentPending.current = true;
    send(pendingMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingMessage]);

  /** `explicitText` is the message carried across a restore navigation
   *  (lib/pending-chat-message.ts). It bypasses `input` because the box is
   *  empty on a fresh mount — the user typed it on the previous screen. */
  function send(explicitText?: string) {
    const text = (explicitText ?? input).trim();
    if (!text || busy) return;

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
    turnStarted.current = true;
    followLatest.current = true;
    setSendingText(text);
    setInput("");
    startTransition(async () => {
      // Measured at SEND time, not on render: the document may have been
      // re-laid-out by fonts loading or a window resize since it was drawn, and
      // the number the model reasons about should describe the page as it is
      // now. Any failure is null, which the prompt states as "not measured"
      // rather than guessing.
      let geometry: unknown = null;
      try {
        const fn = (window as unknown as { __rsmMeasure?: () => unknown }).__rsmMeasure;
        if (typeof fn === "function") geometry = fn();
      } catch {
        geometry = null;
      }
      try {
        const res = await sendChatTurn(jobId, text, geometry);
        setMessages(res.messages);

        // Presence, not truthiness — res.error can legitimately be "".
        if (res.error !== undefined) {
          setError(res.error || UNDESCRIBED_DB_ERROR);
          // Preserve a new draft typed while waiting; restore the failed message only into an empty composer.
          setInput((draft) => draft || text);
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
      } catch {
        setError("The connection was interrupted. Refresh to check whether your change was applied before sending it again.");
        setInput((draft) => draft || text);
      } finally {
        setSendingText(null);
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
      // a chat turn does, so it lands through the same path — INCLUDING the
      // re-render that discards unsaved hand edits, which is why the same
      // guard the send path carries applies here too.
      //
      // The confirm sits AFTER the action, not before it, and the two
      // questions genuinely differ: accepting a bullet into the career
      // overlay is durable, useful on its own, and nothing the user should
      // have to give up to keep an unsaved edit. So the accept always runs
      // and always lands; only the RE-RENDER is negotiable. Declining leaves
      // the hand-edited document exactly as it is and says where the bullet
      // went, rather than silently diverging from the row that was just
      // written.
      if (dirty && !window.confirm(ACCEPT_DIRTY_CONFIRM)) {
        setTranscriptNote(
          "That bullet was added to your career record and placed on the résumé, but the " +
            "document on screen still shows your unsaved edits. Save them, then reload to see it."
        );
        return;
      }
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
    <div className={styles.panel}>
      <div className={styles.transcript} ref={scrollArea} onScroll={(event) => {
        const el = event.currentTarget;
        followLatest.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
      }}>
      {loading && !sendingText && <p role="status" className={styles.notice}>Loading conversation…</p>}
      {loadError && <p role="alert" className={styles.error}>{loadError}</p>}
      {!loading && !loadError && messages.length === 0 && !sendingText && <ChatWelcome onChoose={setInput} disabled={busy} />}

      {messages.length > 0 && (
        <div className={styles.messages}>
          {messages.map((m, i) => {
            const meta = turnMeta[i];
            return (
              <div
                key={i}
                className={
                  m.role === "user"
                    ? styles.user
                    : styles.assistant
                }
              >
                <span className={styles.speaker}>{m.role === "user" ? "You" : "Résumé assistant"}</span>
                <p className={styles.messageText}>{m.text}</p>

                {m.role === "assistant" && meta?.rejected && (
                  <p className={styles.error}>{meta.rejected}</p>
                )}

                {m.role === "assistant" && !meta?.rejected && meta && meta.applied.length > 0 && (
                  <ul aria-label="Applied changes" className={styles.changes}>
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
                  <p className={styles.notice}>{SUMMARY_FLATTEN_NOTE}</p>
                )}

                {m.role === "assistant" && m.proposals && m.proposals.length > 0 && (
                  <div className="mt-2 flex flex-col gap-2">
                    {m.proposals.map((p) => (
                      <div key={p.id} className={styles.proposal}>
                        <p className="text-xs">{p.text}</p>
                        <button
                          onClick={() => accept(i, p.id)}
                          disabled={busy}
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

      {sendingText && <div className={styles.messages} style={{ marginTop: 24 }}>
        <div className={styles.user}><span className={styles.speaker}>You</span><p className={styles.messageText}>{sendingText}</p></div>
        <p role="status" className={styles.working}>Working on your request…</p>
      </div>}
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {transcriptNote && <p role="status" className={styles.notice}>{transcriptNote}</p>}
      </div>
      <ChatComposer value={input} onChange={setInput} onSend={() => send()} disabled={loading} busy={busy} />
    </div>
  );
}
