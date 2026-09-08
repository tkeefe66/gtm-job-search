"use client";

import Script from "next/script";
import { renderBody } from "@/lib/resume-render/render";
import type { CareerRecord, ResumeSelection } from "@/lib/resume-render/render";
import { DEFAULT_PAGE_MARGIN, PORTRAIT_PAGE_CSS } from "@/lib/resume-download";

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
  /** Set by TailorPanel so it can capture the live document on Save. */
  docPageRef?: React.RefObject<HTMLElement>;
  /** Fires on the first and every subsequent edit, so Save can be armed. */
  onEdit?: () => void;
  /** Validated declarations for the .rsm root — see lib/resume-design-tokens. */
  rootStyle?: string;
  /** Overrides <doc-page margin>. NOT captured on Save: it is an attribute on
   *  docPageEl itself, which is outside the innerHTML useResumeCapture reads,
   *  so a saved row carries it in its own column instead. */
  pageMargin?: string;
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
export default function ResumeDocument({
  career,
  selection,
  docPageRef,
  onEdit,
  rootStyle,
  pageMargin,
}: ResumeDocumentProps) {
  const html = renderBody(career, selection, { rootStyle });
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
        ${PORTRAIT_PAGE_CSS}
        doc-page:not(:defined) { visibility: hidden; }
        /* Chrome/Firefox draw a focus outline on whichever element literally
           carries contenteditable, even though the caret sits in a nested
           slotted node — suppressed the same way any WYSIWYG surface does. */
        doc-page[contenteditable] { outline: none; cursor: text; }
      `}</style>
      {/* onInput sets a DIRTY FLAG only — it still does not capture edits into
          React state on every keystroke. The document is read once, on Save,
          straight out of the DOM via captureResumeHtml. "Regenerate" or a
          reload discards unsaved edits by re-setting this HTML from the
          algorithmic selection, which is why no state syncing is needed;
          saving is what makes an edit durable, and only then. */}
      <doc-page
        ref={docPageRef as React.RefObject<HTMLElement>}
        margin={pageMargin || DEFAULT_PAGE_MARGIN}
        contentEditable
        suppressContentEditableWarning
        onInput={onEdit}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </>
  );
}
