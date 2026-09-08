// lib/draft-render.ts
//
// Render a working draft to the same HTML the tailor screen shows.
//
// The composition is otherwise split across loadResumeContext (a "use server"
// action) and ResumeDocument (a client component), so nothing could execute it
// end to end — including a test. The checkpoint written by restoreSavedVersion
// needs exactly this, and a checkpoint that renders anything else is a document
// the user never had.
//
// Order is load-bearing at three points, each of which has a test:
//   - effectiveCareer BEFORE effectiveDocument, so overlay bullets and text
//     overrides exist to be selected;
//   - doc.career (not the merged record) into renderBody, because a
//     compressAfter override is applied to rules.compressAfter;
//   - rootStyle passed, or design tokens vanish and the document renders
//     unstyled while still looking structurally right.
import { effectiveCareer } from "@/lib/effective-career";
import { effectiveDocument } from "@/lib/effective-document";
import { styleAttributeFor } from "@/lib/resume-design-tokens";
import { renderBody } from "@/lib/resume-render/render";
import type { CareerRecord, ResumeSelection } from "@/lib/resume-render/render";
import type { ResumeOverrides } from "@/lib/resume-overrides";
import type { OverlayBullet } from "@/lib/settings-store";

export function renderDraftHtml(input: {
  career: CareerRecord;
  overlay: OverlayBullet[];
  themes: string[];
  baseSelection: ResumeSelection;
  overrides: ResumeOverrides;
}): string {
  const { career: merged } = effectiveCareer(
    input.career,
    input.overlay,
    input.overrides.text || {}
  );
  const doc = effectiveDocument(merged, input.baseSelection, input.themes, input.overrides);
  const rootStyle = styleAttributeFor(input.overrides.design || {});
  return renderBody(doc.career, doc.selection, { rootStyle });
}
