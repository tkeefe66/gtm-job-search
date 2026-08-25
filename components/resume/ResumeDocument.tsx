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
      <Script src="/resume-design/doc-page.js" strategy="afterInteractive" />
      <Script src="/resume-design/page-guides.js" strategy="afterInteractive" />
      <style>{`doc-page:not(:defined) { visibility: hidden; }`}</style>
      <doc-page margin="0.68in" dangerouslySetInnerHTML={{ __html: html }} />
    </>
  );
}
