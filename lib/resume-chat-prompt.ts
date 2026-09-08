// Builds the prompt for the résumé chat agent (app/actions/resume-chat.ts,
// Task 12): everything the model is told about the career record, the
// current document state, the job posting it is tailoring toward, and what
// it is and is not allowed to do to the document. Lives in lib/ for the same
// reason every other *-prompt.ts file here does: the action that calls this
// is a "use server" module, so nothing pure can be exported from it and
// nothing in it can be reached from a test.
//
// Follows lib/resume-prompt.ts's conventions exactly: optionalLine and
// optionalList, where a missing field omits its WHOLE line rather than
// rendering an empty label — an empty "Nice to have:" line reads to the
// model as a posting that stated no preferences at all, not one that has
// none recorded.
//
// `vocabulary` renders in the SAME shape lib/resume-prompt.ts:46-49's
// vocabularyBlock already uses for the sibling theme-derivation prompt —
// `id (label): jdSignal, jdSignal, …` — deliberately, not a different
// format. Fix round 1 found the bullet index's bare theme tags plus 80-char
// previews an insufficient substitute: a theme added to themes.json before
// any bullet is tagged for it would be genuinely unreachable with no signal
// it exists, and even an active id like "systems" doesn't say what it means
// ("Building — A.I. and automation" is the label, not the id) without the
// vocabulary's own descriptive text.
//
// The bullet index carries ids, themes and a TRUNCATED preview of each
// bullet's text — never the full record. A 12-role record with ~60 bullets
// at full text would dominate the context and cost; the model reasons about
// which bullets EXIST from an id, its themes and a preview, and reaches a
// bullet's full text only through a targeted operation
// (add_bullet/swap_bullet/set_text), never by having it pasted here.
//
// Pinned by lib/resume-chat-prompt.test.ts against
// lib/__fixtures__/resume-chat-prompt.txt — the RENDERED prompt, not the
// builder, so a change to what the model is actually told shows up as a
// diff even if every unit test around the builder still passes.
import type {
  CareerRecord,
  ResumeRole,
  ResumeSelection,
  ThemeVocabulary,
} from "@/lib/resume-render/render";
import type { ResumeOverrides } from "@/lib/resume-overrides";
import type { CoverageReport } from "@/lib/resume-coverage";
import { OPERATION_SCHEMA } from "@/lib/resume-ops";
import { DESIGN_TOKENS } from "@/lib/resume-design-tokens";
import { houseFindingsBlock, houseRulesBlock, type HouseFinding } from "@/lib/house-style";

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}

export interface ChatPromptInput {
  career: CareerRecord;
  vocabulary: ThemeVocabulary;
  themes: string[];
  selection: ResumeSelection;
  overrides: ResumeOverrides;
  coverage: CoverageReport;
  /** How the CURRENT document measures against the house-style rules, so the
   *  model knows what it is already breaking before it is asked to change
   *  anything. Optional so the fixture-pinned callers stay explicit about it. */
  houseFindings?: HouseFinding[];
  requirements: string[];
  niceToHaves: string[];
  roleTitle: string;
  company: string;
  messages: ChatMessage[];
}

/** A list renders as one labelled line, or nothing at all — the same
 *  convention lib/resume-prompt.ts's optionalLine/optionalList follow, for
 *  the same reason: an empty "Nice to have:" line reads to the model as a
 *  posting that stated no preferences at all, not one that has none. */
function optionalList(label: string, values: string[]): string {
  if (values.length === 0) return "";
  return `\n${label}: ${values.join("; ")}`;
}

/** Same shape and same source of truth as lib/resume-prompt.ts:46-49's
 *  vocabularyBlock — do not invent a different rendering here; matching the
 *  sibling prompt is the point. */
function vocabularyBlock(vocabulary: ThemeVocabulary): string {
  return vocabulary.themes
    .map((t) => `- ${t.id} (${t.label}): ${t.jdSignals.join(", ")}`)
    .join("\n");
}

const BULLET_PREVIEW_CHARS = 80;

/** The first ~80 characters of a bullet's text — see the file header for why
 *  the full text never reaches this index. */
function previewText(text: string): string {
  if (text.length <= BULLET_PREVIEW_CHARS) return text;
  return text.slice(0, BULLET_PREVIEW_CHARS) + "…";
}

function bulletIndexBlock(career: CareerRecord): string {
  return career.roles
    .map((role: ResumeRole) => {
      const header = `${role.id} — ${role.title} @ ${role.org} (${role.dates})`;
      const bullets = role.bullets
        .map((b) => `  - ${b.id} [${b.themes.join(", ")}]: ${previewText(b.text)}`)
        .join("\n");
      return `${header}\n${bullets}`;
    })
    .join("\n");
}

function selectionBlock(career: CareerRecord, selection: ResumeSelection): string {
  const bulletLines = career.roles
    .map((role) => {
      const ids = selection.bullets[role.id] || [];
      return ids.length ? `${role.id}: ${ids.join(", ")}` : null;
    })
    .filter((l): l is string => l !== null);
  const lines = selection.positioningId
    ? [`Positioning: ${selection.positioningId}`, ...bulletLines]
    : bulletLines;
  return lines.length ? lines.join("\n") : "(no selection yet)";
}

function overridesBlock(overrides: ResumeOverrides): string {
  const lines: string[] = [];
  const sel = overrides.selection;
  if (sel) {
    if (sel.lead) lines.push(`Lead bullet: ${sel.lead}`);
    if (sel.positioning) lines.push(`Positioning: ${sel.positioning}`);
    if (sel.taper) lines.push(`Taper: ${sel.taper.join(", ")}`);
    if (sel.compressAfter != null) lines.push(`Compress after: ${sel.compressAfter}`);
    if (sel.bullets) {
      Object.keys(sel.bullets).forEach((roleId) => {
        // An empty array here is MEANINGFUL — it says this role now shows no
        // bullets, which is different from the role having no override at
        // all — so it renders "(none)" rather than a dangling empty label
        // ("Bullets override, manager: " with nothing after the colon).
        const ids = sel.bullets![roleId];
        lines.push(`Bullets override, ${roleId}: ${ids.length ? ids.join(", ") : "(none)"}`);
      });
    }
  }
  if (overrides.text) {
    Object.keys(overrides.text).forEach((target) => {
      lines.push(`Text override, ${target}: ${overrides.text![target]}`);
    });
  }
  if (overrides.design) {
    Object.keys(overrides.design).forEach((name) => {
      lines.push(`Design token override, ${name}: ${overrides.design![name]}`);
    });
  }
  if (overrides.pageMargin) lines.push(`Page margin: ${overrides.pageMargin}`);
  return lines.length ? lines.join("\n") : "(no overrides yet — the document matches the base tailored selection)";
}

function coverageBlock(coverage: CoverageReport): string {
  const themeLines = coverage.themes.map((t) => {
    const beyond = t.poolBeyondRendered > 0 ? `, ${t.poolBeyondRendered} more in compressed roles` : "";
    return `- ${t.theme}: ${t.support} (selected ${t.selected} of ${t.pool} in the pool${beyond})`;
  });
  const strength = coverage.strength == null ? "n/a" : coverage.strength.toFixed(2);
  const lines = [
    ...themeLines,
    `Strength: ${strength}`,
    `Overlay bullets on the page: ${coverage.overlayBullets}`,
    `Edited bullets on the page: ${coverage.editedBullets}`,
  ];
  if (coverage.gaps.length) lines.push(`Gaps (no support at all): ${coverage.gaps.join(", ")}`);
  if (coverage.unknown.length) lines.push(`Unknown themes: ${coverage.unknown.join(", ")}`);
  return lines.join("\n");
}

/** The shape of OPERATION_SCHEMA's nested enum that actually holds the
 *  accepted operation names — cast narrowly, rather than retyped, so this
 *  catalogue cannot silently drift from lib/resume-ops.ts's validator. */
interface OperationEnumShape {
  properties: {
    operations: {
      items: {
        properties: {
          op: { enum: string[] };
        };
      };
    };
  };
}

function operationNames(): string[] {
  const shape = OPERATION_SCHEMA as unknown as OperationEnumShape;
  return shape.properties.operations.items.properties.op.enum;
}

/** One short line of guidance per operation. Keyed by the same names
 *  OPERATION_SCHEMA declares, but the CATALOGUE below is driven by iterating
 *  operationNames() — a name missing here still renders (with no
 *  description) rather than silently vanishing from the prompt. */
const OPERATION_DESCRIPTIONS: Record<string, string> = {
  set_themes: "replace the ranked theme list driving bullet selection.",
  add_bullet: "add one bullet from a role's pool to the current selection.",
  drop_bullet: "remove one bullet from the current selection.",
  swap_bullet: "replace one selected bullet with another from the same role's pool.",
  // Matches validateOperation's actual check: set_lead takes any bullet in
  // the pool, selected or not, but ONLY from the most recent role — the lead
  // bullet is the first rendered line and render.js honours opts.lead at
  // role index 0 alone. The prose must describe the validator, not the other
  // way around.
  set_lead:
    "make one bullet from the most recent role's pool the first line of the résumé — it does not need to be selected already.",
  set_positioning: "switch to a different positioning variant from the career record.",
  set_taper: "set how many bullets render per role, most senior role first.",
  set_compress_after: "compress roles after the n-th into one-line rows.",
  set_text:
    'edit the text of "summary", "positioning", "name" (the header name), or a selected bullet ("bullet:<roleId>:<bulletId>").',
  propose_career_bullet:
    "propose a NEW bullet on a role for the user to accept — the only way a bullet is added; it is never invented straight into the document.",
  set_design_token: "set one design token to a value within its allowed range.",
  set_page_margin: "set the page margin.",
  reset_design: "clear every design token and page margin override.",
  request_rule_change:
    "ask for a layout change that needs a new CSS rule — the escape hatch for anything the allowlisted design tokens cannot express.",
};

function operationCatalogueBlock(): string {
  return operationNames()
    .map((name) => `- ${name}: ${OPERATION_DESCRIPTIONS[name] || ""}`)
    .join("\n");
}

/** Names ALONE were all the model used to get, which is why it invented
 *  plausible-but-nonexistent tokens and proposed values outside the accepted
 *  range: it could not see the range, the units, or what any knob controls.
 *  TokenSpec already carries min/max/units — none of it was reaching the
 *  prompt. */

/** What each knob actually controls. The token NAMES are self-describing to
 *  someone who has read document.css and opaque to everyone else — including a
 *  model asked to "tighten the spacing". */
const TOKEN_PURPOSE: Record<string, string> = {
  "--rail": "width of the left section-label column",
  "--gap-bullet": "vertical space between bullets",
  "--type-body": "body and bullet font size",
  "--type-meta": "dates and contact-line font size",
  "--type-name": "the header name font size",
  "--type-org": "employer line font size",
  "--type-role": "role title font size",
  "--type-section": "section label font size",
  "--leading-tight": "line height for headings and tight blocks",
  "--tracking-tight": "letter spacing for section labels",
  "--ink-900": "primary heading colour",
  "--text-primary": "body text colour",
  "--rule-100": "hairline rule colour",
  "--rule-200": "heavier rule colour",
  "--link": "link colour",
};

function designTokenBlock(): string {
  return DESIGN_TOKENS.map((t) => {
    const purpose = TOKEN_PURPOSE[t.name] ? ` — ${TOKEN_PURPOSE[t.name]}` : "";
    if (t.kind === "color") return `- ${t.name} (color: hex or a CSS colour keyword)${purpose}`;
    const units = t.units ? t.units.filter((u) => u !== "").join("/") : "";
    const range = t.min !== undefined && t.max !== undefined ? `${t.min}–${t.max}` : "";
    return `- ${t.name} (length ${range}${units ? ", " + units : ""})${purpose}`;
  }).join("\n");
}

function transcriptBlock(messages: ChatMessage[]): string {
  return messages.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`).join("\n");
}

/** The invariant this repo's terms state it in — verbatim, because the whole
 *  point of request_rule_change existing is that a model told anything
 *  weaker will instead emit a plausible token edit that silently does
 *  nothing. */
const INVARIANT = `You may reorder and retune the document freely. You may not invent a bullet — propose it and let the user accept it. You may not write CSS rules; if a change needs one, say so with request_rule_change.`;

export function buildChatPrompt(input: ChatPromptInput): { system: string; prompt: string } {
  const system = `You are editing one tailored résumé through a fixed set of document operations. You never write résumé prose or CSS directly — every change to the document happens through one of the operations below, and the document itself is rendered deterministically from the resulting selection and overrides, never from anything you write out.

THEME VOCABULARY
${vocabularyBlock(input.vocabulary)}

THEMES CURRENTLY DRIVING SELECTION
${input.themes.length ? input.themes.join(", ") : "(none set)"}

BULLET INDEX (role — title @ org (dates), then each bullet's id, themes, and a preview of its text)
${bulletIndexBlock(input.career)}

CURRENT SELECTION
${selectionBlock(input.career, input.selection)}

CURRENT OVERRIDES
Wherever this section names a role or field also shown in CURRENT SELECTION above, CURRENT OVERRIDES wins — it is what has already been layered on top of that selection.
${overridesBlock(input.overrides)}

COVERAGE REPORT
${coverageBlock(input.coverage)}

OPERATIONS YOU MAY CALL
${operationCatalogueBlock()}

DESIGN TOKENS set_design_token MAY ADJUST (no others are accepted)
${designTokenBlock()}

HOUSE STYLE — what a good résumé looks like. Judge your own change against
these before reporting it done, and say so when a request would break one.
${houseRulesBlock()}

HOW THE DOCUMENT MEASURES AGAINST THEM RIGHT NOW
${houseFindingsBlock(input.houseFindings || [])}

${INVARIANT}`;

  const prompt = `JOB
Title: ${input.roleTitle}
Company: ${input.company}${optionalList("Requirements", input.requirements)}${optionalList("Nice to have (not required)", input.niceToHaves)}

CONVERSATION
${transcriptBlock(input.messages)}
`;

  return { system, prompt };
}
