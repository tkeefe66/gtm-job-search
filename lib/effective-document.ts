// lib/effective-document.ts
//
// The hop from an OVERRIDE to a rendered document. One definition, used by
// app/actions/resume.ts's loadResumeContext (every page load) and by
// app/actions/resume-chat.ts's sendChatTurn/acceptProposedBullets (every
// turn), so what a turn reports and what a reload renders cannot drift.
//
// Why this file exists at all: the design spec is explicit that "every
// operation is applied by re-running selectBullets and renderBody over a
// different effective record — the document is always a render"
// (docs/superpowers/specs/2026-09-07-resume-chat-design.md). Before this
// module, the only production call of selectBullets was inside
// tailorResumeForJob and it passed `themes` alone, so `taper`, `lead` and
// `compressAfter` were written into overrides, persisted, billed and
// reported to the user as applied while reaching no renderer at all. The
// final pre-merge review measured all three as permanently inert.
//
// The four rules, in the order they run:
//
//   1. TAPER re-derives the base. A taper decides how MANY bullets each role
//      keeps, which is a selection decision, so the only honest way to apply
//      it is to hand it to selectBullets and let scoring re-pick.
//   2. Per-role bullet lists and positioning layer on top (effectiveSelection).
//      An explicit per-role edit therefore OUTRANKS a taper for that role:
//      "show exactly these bullets on this role" is a decision the user made
//      about that role by name, and silently truncating it to a later global
//      cap would delete a bullet they asked for with nothing to say so. Every
//      role they have NOT hand-edited still obeys the taper.
//   3. Every role gets an explicit list (fillMissingRoles). render.js:171
//      falls back to a role's WHOLE POOL for a role absent from the
//      selection, while lib/resume-ops.ts and lib/resume-coverage.ts fall
//      back to []. Measured on the shipped record, that disagreement made one
//      drop_bullet remove six lines: the op read the absent role as having no
//      bullets, wrote `[]`, and six rendered lines vanished while the chat
//      reported dropping one. Filling from the record here gives all three
//      surfaces the same answer — render.js's — and it is applied AFTER the
//      merge so an override of `[]` (a real "this role shows nothing") is
//      preserved.
//   4. LEAD is applied last, as a reordering of the final list rather than
//      through selectBullets' own `opts.lead`. Through selectBullets it would
//      be silently discarded for any role carrying a per-role override (rule
//      2 replaces that role's list wholesale), which is the same
//      advertised-and-inert failure this module exists to end. Count is
//      preserved the way render.js:73-79 preserves it.
//
// COMPRESS-AFTER: overridden on the RECORD (`rules.compressAfter`), not
// threaded as a renderBody option. renderBody reads `career.rules.compressAfter`
// (render.js:133) and lib/resume-coverage.ts's renderedRoles reads the same
// field, so overriding the record makes ONE change reach both, plus every
// future reader, with no third dated divergence in the vendored render.js.
// The alternative — a new renderBody option — would have to be duplicated
// into coverage anyway and would put app-specific plumbing into a file whose
// header forbids exactly that. The record returned here is FRESH, with a
// fresh `rules` object: lib/effective-career.ts's top-level spread shares
// `rules` with the process-wide content/resume.json import, so mutating it in
// place would corrupt every later request in the process.
import { selectBullets } from "@/lib/resume-render/render";
import { effectiveSelection } from "@/lib/effective-selection";
import type { CareerRecord, ResumeSelection } from "@/lib/resume-render/render";
import type { ResumeOverrides } from "@/lib/resume-overrides";

/** Every role in the record gets an explicit list; an existing entry — empty
 *  array included — is never touched. See rule 3 above. */
function fillMissingRoles(career: CareerRecord, selection: ResumeSelection): ResumeSelection {
  const bullets: Record<string, string[]> = { ...selection.bullets };
  let changed = false;
  career.roles.forEach((role) => {
    if (Object.prototype.hasOwnProperty.call(bullets, role.id)) return;
    bullets[role.id] = role.bullets.map((b) => b.id);
    changed = true;
  });
  return changed ? { positioningId: selection.positioningId, bullets } : selection;
}

/** Moves `lead` to the front of the FIRST role's list, keeping the list's
 *  length — the same trade render.js makes when a lead bullet is not already
 *  selected. A lead that names no bullet in that role's pool is ignored. */
function withLead(career: CareerRecord, selection: ResumeSelection, lead: string): ResumeSelection {
  const role = career.roles[0];
  if (!role || !role.bullets.some((b) => b.id === lead)) return selection;
  const current = selection.bullets[role.id] || [];
  if (current[0] === lead) return selection;
  const rest = current.filter((id) => id !== lead);
  const next = [lead].concat(current.indexOf(lead) === -1 ? rest.slice(0, Math.max(0, current.length - 1)) : rest);
  return {
    positioningId: selection.positioningId,
    bullets: { ...selection.bullets, [role.id]: next },
  };
}

export function effectiveDocument(
  career: CareerRecord,
  base: ResumeSelection,
  themes: string[],
  overrides: ResumeOverrides
): { career: CareerRecord; selection: ResumeSelection } {
  const sel = overrides.selection;

  let selection = base;
  if (sel && sel.taper && sel.taper.length > 0) {
    selection = selectBullets(career, { themes, taper: sel.taper });
  }
  selection = effectiveSelection(selection, sel);
  selection = fillMissingRoles(career, selection);
  if (sel && typeof sel.lead === "string" && sel.lead) {
    selection = withLead(career, selection, sel.lead);
  }

  const shaped =
    sel && sel.compressAfter != null
      ? { ...career, rules: { ...career.rules, compressAfter: sel.compressAfter } }
      : career;

  return { career: shaped, selection };
}
