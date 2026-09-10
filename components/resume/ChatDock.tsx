"use client";

import { useId, useRef, useState, type ReactNode } from "react";
import styles from "./chat.module.css";

export default function ChatDock({ title, children, defaultOpen = false }: {
  title: string; children: ReactNode; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [opened, setOpened] = useState(defaultOpen);
  const [expanded, setExpanded] = useState(false);
  const launcher = useRef<HTMLButtonElement>(null);
  const id = useId();
  function minimize() {
    setOpen(false);
    requestAnimationFrame(() => launcher.current?.focus());
  }
  return <div className="print:hidden">
    {!open && <button ref={launcher} className={styles.launcher} aria-expanded={false} aria-controls={id}
      onClick={() => { setOpened(true); setOpen(true); requestAnimationFrame(() => document.getElementById(id)?.querySelector("textarea")?.focus()); }}>
      <ChatIcon /> Résumé assistant
    </button>}
    {/* Keep opened content mounted so minimizing preserves unsent text and in-flight turns. */}
    {opened && <section id={id} aria-label={title} hidden={!open}
      className={`${styles.dock} ${expanded ? styles.expanded : ""}`}
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); minimize(); } }}>
      <header className={styles.header}>
        <div className={styles.identity}><span className={styles.mark}><ChatIcon /></span>
          <div><h2>Résumé assistant</h2><p>Refine the story. Make it yours.</p></div>
        </div>
        <div className={styles.controls}>
          <button type="button" aria-label={expanded ? "Restore chat size" : "Expand chat"} aria-pressed={expanded}
            onClick={() => setExpanded(!expanded)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d={expanded ? "M9 3v6H3m18 6h-6v6M9 9 3 3m12 12 6 6" : "M8 3H3v5m13 13h5v-5M3 3l7 7m11 11-7-7"}/></svg>
          </button>
          <button type="button" aria-label="Minimize chat" onClick={minimize}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg>
          </button>
        </div>
      </header>
      <div className={styles.body}>{children}</div>
    </section>}
  </div>;
}

function ChatIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H5l-3 3V11.5A7.5 7.5 0 0 1 9.5 4h3a7.5 7.5 0 0 1 7.5 7.5Z"/><path d="M7 10h8M7 14h5"/></svg>;
}
