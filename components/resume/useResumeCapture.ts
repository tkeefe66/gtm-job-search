"use client";

/**
 * Serializes the live document for saving.
 *
 * TWO things here are load-bearing and both are invisible until after a row is
 * written:
 *
 *  1. It captures docPageEl.innerHTML, NOT the .rsm div's innerHTML.
 *     document.css:5 scopes the entire design to `.rsm`, and that wrapper is
 *     emitted by renderBody (render.js:127). One level deeper loses the root
 *     every selector hangs off and the saved résumé renders as unstyled text.
 *  2. It removes the on-screen page guides first. rsm-page-guides.js appends
 *     them INSIDE the .rsm element (:138) while their styles go to
 *     document.head (:59), so they travel with a capture and their styling does
 *     not — they would freeze stale break markers into the row and show as
 *     literal "Page 2" text in a downloaded file. Its @media print hide (:57)
 *     is why this never showed up in printing.
 *
 * The sanitizer drops them again server-side; this is the belt, that is the
 * braces.
 */
export function captureResumeHtml(docPageEl: HTMLElement): string {
  const clone = docPageEl.cloneNode(true) as HTMLElement;
  const guides = clone.querySelectorAll(".rsm-page-guide");
  for (let i = 0; i < guides.length; i++) {
    const g = guides[i];
    if (g.parentNode) g.parentNode.removeChild(g);
  }
  return clone.innerHTML;
}
