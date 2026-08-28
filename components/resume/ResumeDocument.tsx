"use client";

import Script from "next/script";
import { renderBody } from "@/lib/resume-render/render";
import type { CareerRecord, ResumeSelection } from "@/lib/resume-render/render";

// `<doc-page>` is a custom element defined by /public/resume-design/doc-page.js
// at runtime — not a React component. This augments JSX so TypeScript accepts
// it as an intrinsic element.
declare global {
  namespace JSX {
    interface IntrinsicElements {
      "doc-page": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & { margin?: string },
        HTMLElement
      >;
    }
  }
}

export interface ResumeDocumentProps {
  career: CareerRecord;
  /** Omit to render every bullet in every role, unfiltered. */
  selection?: ResumeSelection;
}

/**
 * Renders a résumé document inside the `<doc-page>` print/pagination shell
 * from the "TK Resume Design System" Claude Design project — a real,
 * external custom element (public/resume-design/doc-page.js), not
 * reimplemented here. The `.rsm` markup itself is produced by `renderBody()`
 * (lib/resume-render/render.js, ported verbatim from the same project) —
 * this component does not hand-author any `.rsm`-scoped HTML; the class
 * contract lives in render.js so a change to the design system reaches
 * every consumer, per that file's own header comment.
 */
export default function ResumeDocument({ career, selection }: ResumeDocumentProps) {
  const html = renderBody(career, selection);
  return (
    <>
      {/* The vendored page-guides.js (the "PAGE 2" dashed-line overlay) is
          deliberately NOT loaded here — it estimates breaks by dividing
          rendered height by page height alone, with zero awareness of
          break-inside/break-after/break-before, so it drew its line between
          a role's header and its bullets even after the real print output
          stopped splitting there. rsm-page-guides.js (this app's own,
          coupled to .rsm-role's actual structure) walks the same break
          rules document.css enforces, so it can't suggest a break the real
          print engine would refuse. */}
      <Script src="/resume-design/doc-page.js" strategy="afterInteractive" />
      <Script src="/resume-design/rsm-page-guides.js" strategy="afterInteractive" />
      <style>{`
        doc-page:not(:defined) { visibility: hidden; }
        /* Chrome/Firefox draw a focus outline on whichever element literally
           carries contenteditable, even though the caret sits in a nested
           slotted node — suppressed the same way any WYSIWYG surface does. */
        doc-page[contenteditable] { outline: none; cursor: text; }
      `}</style>
      {/* No onInput handler: edits are intentionally not captured back into
          React state or persisted anywhere. This is live-DOM click-to-edit,
          not a data-model change — "Regenerate" or a reload discards edits
          by re-setting this HTML from the algorithmic selection, which is
          the whole reason no state syncing is needed. */}
      <doc-page
        margin="0.68in"
        contentEditable
        suppressContentEditableWarning
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </>
  );
}
