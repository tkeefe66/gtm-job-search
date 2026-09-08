// lib/effective-selection.ts
//
// The base ResumeSelection with a bullet-level/positioning override layered
// on top — what is actually on the page right now, as opposed to what
// tailoring alone produced.
//
// ONE definition, used by both app/actions/resume-chat.ts (to validate
// against and to return the post-turn selection a caller renders) and
// app/actions/resume.ts's loadResumeContext (so a page reload after a
// bullet-level chat edit shows the SAME document the chat turn just
// produced, rather than the stale unmerged base). Two copies of this merge
// is precisely the drift hazard this module exists to close — the fix-round
// review that requested this file compared it against lib/resume-ops.ts's
// own rule for exactly that reason.
//
// Lives in lib/ rather than in either "use server" action file: both
// actions need it, and "use server" forbids non-async exports, so the
// import direction would become load-bearing for a function that is not.
//
// `lead`/`taper`/`compressAfter` are NOT folded in: `ResumeSelection` has no
// fields for them (only `positioningId` and `bullets`), so those overrides
// stay exactly where lib/resume-ops.ts's applyOperations already puts them,
// in `overrides.selection` — wiring them into rendering is a later task's
// job, the same way `overrides.design`/`overrides.pageMargin` are consumed
// outside `ResumeSelection` today.
//
// `tailored_resumes.content.selection` always stores the UNMERGED base —
// this function's result is never what gets persisted there, only what gets
// returned to a caller and validated against, so Regenerate's "discard
// every chat override" contract is unaffected.
import type { ResumeSelection } from "@/lib/resume-render/render";
import type { ResumeOverrides } from "@/lib/resume-overrides";

export function effectiveSelection(
  base: ResumeSelection,
  sel?: ResumeOverrides["selection"]
): ResumeSelection {
  if (!sel) return base;
  const bullets: Record<string, string[]> = { ...base.bullets };
  if (sel.bullets) {
    Object.keys(sel.bullets).forEach((roleId) => {
      bullets[roleId] = sel.bullets![roleId];
    });
  }
  return {
    positioningId: sel.positioning !== undefined ? sel.positioning : base.positioningId,
    bullets,
  };
}
