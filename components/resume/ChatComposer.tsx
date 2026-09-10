"use client";

import { useEffect, useRef } from "react";
import styles from "./chat.module.css";

export default function ChatComposer({ value, onChange, onSend, disabled, busy = false }: {
  value: string; onChange: (value: string) => void; onSend: () => void; disabled: boolean; busy?: boolean;
}) {
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!field.current) return;
    field.current.style.height = "auto";
    field.current.style.height = `${Math.min(field.current.scrollHeight, 144)}px`;
  }, [value]);
  return <div className={styles.composerArea}>
    <form className={styles.composer} onSubmit={(event) => { event.preventDefault(); if (!disabled && !busy && value.trim()) onSend(); }}>
      <textarea ref={field} rows={2} aria-label="Message résumé assistant" placeholder="Ask a question or describe a change…"
        value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (!disabled && !busy && value.trim()) onSend();
          }
        }}/>
      <div className={styles.composerFooter}><span>{busy ? "Reply in progress · you can keep typing" : "Shift + Enter for a new line"}</span>
        <button type="submit" disabled={disabled || busy || !value.trim()} aria-label={busy ? "Working on your request" : "Send message"}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6"/></svg>
        </button>
      </div>
    </form>
    <p className={styles.caption}>Review changes in your résumé before saving.</p>
  </div>;
}

export function ChatWelcome({ onChoose, disabled = false }: { onChoose: (text: string) => void; disabled?: boolean }) {
  return <div className={styles.welcome}>
    <h3>A stronger résumé,<br/>one conversation at a time.</h3>
    <p>Work on the wording, sharpen a bullet, or find a better way to tell your story.</p>
    <div className={styles.suggestions}>
      {["Tighten my summary", "Strengthen my bullets", "Review the layout"].map((prompt) =>
        <button key={prompt} type="button" disabled={disabled} onClick={(event) => {
          onChoose(prompt);
          event.currentTarget.closest("section")?.querySelector("textarea")?.focus();
        }}>{prompt}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M7 7h10v10"/></svg></button>)}
    </div>
  </div>;
}
