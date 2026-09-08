"use client";

import { useState } from "react";

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
    return <p className="text-xs text-ink/60">{blockedNote}</p>;
  }

  function submit() {
    const trimmed = text.trim();
    if (!trimmed || isPending) return;
    onSend(trimmed);
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-ink/60">
        Sending opens this version as your working draft and asks there. Your current draft is
        saved as a checkpoint first.
      </p>
      <div className="flex items-center gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Ask for a change, e.g. “cut every role to three bullets”"
          disabled={isPending}
          className="flex-1 rounded border border-slate px-3 py-1.5 text-sm"
        />
        <button
          onClick={submit}
          disabled={isPending || text.trim() === ""}
          className="rounded border border-slate px-3 py-1.5 text-sm hover:border-ink disabled:opacity-50"
        >
          {isPending ? "Opening…" : "Send"}
        </button>
      </div>
    </div>
  );
}
