"use client";

import { useState } from "react";
import ChatComposer, { ChatWelcome } from "./ChatComposer";
import styles from "./chat.module.css";

/**
 * The chat composer shown on a SAVED résumé.
 *
 * Deliberately not ChatPanel: that component loads and renders a thread and
 * applies turns against a live document, and this screen has neither — the row
 * is frozen HTML with no selection. What it offers instead is the one thing
 * that CAN happen here: type a message, and sending it restores this version
 * into the working draft and carries the message there (SavedResumePanel's
 * sendFromSaved → chatSendPlan → editThisVersion).
 *
 * So this shows the composer plus a sentence about what pressing send does. The
 * alternative — rendering the thread here too — would be a second chat
 * implementation whose messages describe a document this screen is not showing.
 */
export default function SavedChatLauncher({
  onSend,
  blockedNote,
  isPending,
}: {
  onSend: (text: string) => void;
  /** Set when this row cannot be edited at all (pre-021, or its job was
   *  deleted). The composer is withheld rather than accepting a message that
   *  has nowhere to go. */
  blockedNote?: string;
  isPending: boolean;
}) {
  const [text, setText] = useState("");

  if (blockedNote) {
    return <div className={styles.transcript}><p className={styles.notice}>{blockedNote}</p></div>;
  }

  function submit() {
    const trimmed = text.trim();
    if (!trimmed || isPending) return;
    onSend(trimmed);
  }

  return (
    <div className={styles.panel}>
      <div className={styles.transcript}>
        <ChatWelcome onChoose={setText} disabled={isPending} />
        <p className={styles.notice}>
          Sending opens this version as your working draft and asks there. Your current draft is
          saved as a checkpoint first.
        </p>
        {isPending && <p role="status" className={styles.working}>Opening your working draft…</p>}
      </div>
      <ChatComposer value={text} onChange={setText} onSend={submit} disabled={isPending} busy={isPending} />
    </div>
  );
}
