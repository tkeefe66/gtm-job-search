"use client";

import { useState, type ReactNode } from "react";

/**
 * The floating shell the résumé chat lives in, on BOTH the tailor screen and a
 * saved résumé. Presentation only — it owns open/closed and nothing else, so
 * ChatPanel's turn state, proposals and accept flow stay exactly where they
 * were and there is one chat implementation rather than two.
 *
 * `print:hidden` on the root is load-bearing: nothing in this app hides chrome
 * at print by default (app/layout.tsx and TailorPanel scope their own), so a
 * fixed-position panel without it prints on top of the résumé — and the résumé
 * is the one document whose print output is the product.
 */
export default function ChatDock({
  title,
  children,
  defaultOpen = false,
}: {
  title: string;
  children: ReactNode;
  /** The tailor screen opens by default (the chat is the point of that page);
   *  a saved résumé does not, because the document is what you came to read. */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 z-40 rounded-full border border-slate bg-white px-4 py-2 text-sm shadow-lg hover:border-ink print:hidden"
      >
        💬 {title}
      </button>
    );
  }

  return (
    // Width is capped by the viewport as well as by rem, so it collapses on a
    // laptop instead of covering the document it is meant to discuss.
    <div className="fixed bottom-6 right-6 z-40 flex max-h-[70vh] w-[min(24rem,calc(100vw-3rem))] flex-col rounded-lg border border-slate bg-white shadow-xl print:hidden">
      <div className="flex items-center justify-between border-b border-slate px-3 py-2">
        <span className="text-xs font-medium uppercase tracking-wide text-ink/60">{title}</span>
        <button
          onClick={() => setOpen(false)}
          aria-label="Close chat"
          className="rounded px-2 text-sm text-ink/60 hover:text-ink"
        >
          ✕
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-2">{children}</div>
    </div>
  );
}
