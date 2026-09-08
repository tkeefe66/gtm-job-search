// What a good résumé looks like, stated where the model can read it.
//
// The design system (public/resume-design/, lib/resume-design-tokens.ts) tells
// the agent which knobs exist and nothing else — fifteen token names, no
// ranges, no semantics, no feedback. It constrains RENDERING; it says nothing
// about AUTHORING. So there was no answer anywhere to "is this a good
// document?", and the agent flattened a taper to [5,5,5,5,5] and reported
// success, because nothing had ever said that a flat taper tells the reader a
// 2013 job matters as much as the current one.
//
// This is the missing artifact. themes.json taught the model what the CAREER
// is; this teaches it what the DOCUMENT should be. Same shape: checked-in
// knowledge handed to the model, plus a pure evaluator so the rules are
// enforced rather than merely hoped for.
//
// Every rule carries a RATIONALE, and it is not decoration: the rationale goes
// into the prompt. "Taper must not increase" teaches nothing transferable —
// the reason is what lets the model apply the rule to a case the statement does
// not literally cover.
//
// Deliberately absent: anything needing page geometry. Page count, orphaned
// headers and white space need the rendered document measured in a browser
// (rsm-page-guides.js already does this client-side, and feeding it back is a
// separate change). A line-count estimate here would be confidently wrong,
// which is worse than silent.
import type { CareerRecord, ResumeSelection } from "@/lib/resume-render/render";

export interface HouseRule {
  id: string;
  statement: string;
  rationale: string;
}

export interface HouseFinding {
  rule: string;
  detail: string;
}

export const HOUSE_RULES: HouseRule[] = [
  {
    id: "taper-descends",
    statement: "Each rendered role carries no more bullets than the role above it.",
    rationale:
      "The bullet count is how the page says which job matters most. A flat or rising taper tells the reader a job from a decade ago is as important as the current one, which is never what the candidate means.",
  },
  {
    id: "no-empty-role",
    statement: "Every rendered role has at least one bullet.",
    rationale:
      "The renderer drops a role entirely when none of its bullets survive, so a role with an empty selection does not appear as an empty heading — the job silently vanishes from the résumé.",
  },
  {
    id: "no-em-dash",
    statement: "No text in the document contains an em dash (\u2014). Use a comma, a colon, or a full stop instead.",
    rationale:
      "The owner of this r\u00e9sum\u00e9 will not ship a document containing one. sanitizeBulletText rewrites any em dash you write into a comma before it reaches the page, so text authored around one reads as though a clause were missing; write the punctuation you actually want.",
  },
  {
    id: "positioning-present",
    statement: "The document keeps its summary paragraph.",
    rationale:
      "The summary is the only place the résumé states what the candidate is — the masthead renders the name and contact line and nothing else. Losing it leaves the reader to infer a thesis from the bullets, which is work they will not do.",
  },
];

const RULE_BY_ID: Record<string, HouseRule> = Object.create(null);
HOUSE_RULES.forEach((r) => {
  RULE_BY_ID[r.id] = r;
});

/** The roles renderBody actually draws bullets for. Same rule
 *  lib/resume-coverage.ts's renderedRoles follows, and for the same reason:
 *  roles past compressAfter render as one-line rows with no bullets, so judging
 *  them by bullet count reports a violation on every correct document. */
function renderedRoles(career: CareerRecord) {
  const compressAfter = career.rules ? career.rules.compressAfter : null;
  return compressAfter == null ? career.roles : career.roles.slice(0, compressAfter);
}

function selectedPositioning(career: CareerRecord, selection: ResumeSelection) {
  const chosen = (career.positioning || []).filter((p) => p.id === selection.positioningId)[0];
  return chosen || (career.positioning || [])[0];
}

function countFor(selection: ResumeSelection, roleId: string): number {
  const bullets = selection.bullets || {};
  return Object.prototype.hasOwnProperty.call(bullets, roleId) ? bullets[roleId].length : 0;
}

/**
 * Judge the EFFECTIVE document — the record and selection that will actually
 * render, after overrides. Never the taper array: that is advisory, an explicit
 * per-role bullet list overrides it, and a role can simply run out of pool, so
 * only the selection says what reaches the page.
 */
export function evaluateHouseStyle(
  career: CareerRecord,
  selection: ResumeSelection
): HouseFinding[] {
  const findings: HouseFinding[] = [];
  const roles = renderedRoles(career);

  const empty = roles.filter((r) => countFor(selection, r.id) === 0);
  if (empty.length > 0) {
    findings.push({
      rule: "no-empty-role",
      detail:
        "These roles would render with no bullets and disappear from the page: " +
        empty.map((r) => r.title).join(", ") +
        ".",
    });
  }

  for (let i = 1; i < roles.length; i++) {
    const above = countFor(selection, roles[i - 1].id);
    const here = countFor(selection, roles[i].id);
    // A role with no bullets is already reported by no-empty-role; reporting it
    // here too would name one mistake twice.
    if (here > 0 && above > 0 && here > above) {
      findings.push({
        rule: "taper-descends",
        detail: `"${roles[i].title}" has ${here} bullets against ${above} on "${roles[i - 1].title}" above it.`,
      });
      break;
    }
    if (here > 0 && above > 0 && here === above && here > 1) {
      findings.push({
        rule: "taper-descends",
        detail: `"${roles[i].title}" and "${roles[i - 1].title}" both have ${here} bullets, so the page does not say which matters more.`,
      });
      break;
    }
  }

  // The tagline is NOT consulted: since the 2026-09-08 design sync the masthead
  // renders the name and one contact line only, so a tagline reaches no reader
  // and could not stand in for a missing summary.
  const pos = selectedPositioning(career, selection);
  const summary = pos && pos.summary ? pos.summary.trim() : "";
  if (summary === "") {
    findings.push({
      rule: "positioning-present",
      detail: "The summary is empty, so the résumé opens with the name and contact line and then jumps straight to the roles.",
    });
  }

  return findings;
}

/** The rules as the model receives them. Statement AND rationale — see the
 *  header for why the rationale is load-bearing rather than commentary. */
export function houseRulesBlock(): string {
  return HOUSE_RULES.map((r) => `- ${r.statement}\n  Why: ${r.rationale}`).join("\n");
}

/** Findings as the model receives them, after a turn. */
export function houseFindingsBlock(findings: HouseFinding[]): string {
  if (findings.length === 0) return "The document currently meets every house-style rule.";
  return findings
    .map((f) => {
      const rule = RULE_BY_ID[f.rule];
      return `- ${rule ? rule.statement : f.rule}\n  ${f.detail}`;
    })
    .join("\n");
}
