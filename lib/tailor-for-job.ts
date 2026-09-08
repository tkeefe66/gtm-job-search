// tailorForJob — pasted job-description text in, a tailored résumé out.
//
// The division of labour is the whole point, and it is not negotiable:
//
//   the model   picks theme ids and a positioning id from fixed lists
//   selectBullets  decides which bullets survive, and in what order
//   renderResume   turns that selection into HTML
//
// The model never writes, edits, or rewrites a line of the résumé. Every
// sentence on the page is copied character-for-character out of
// content/resume.json, which is what makes the document defensible in an
// interview — a model paraphrasing a bullet at request time would break that
// silently, and the page would look no different.
//
// Nothing here reimplements selection, scoring, or the taper. render.js's
// selectBullets owns all three, including the rule that each role's priority-1
// bullet always survives, and this file must never filter its output.
import { complete as defaultComplete, parseJson } from "@/lib/model-call";
import { buildJdThemePrompt } from "@/lib/jd-theme-prompt";
import { coverageReport, type CoverageReport } from "@/lib/resume-coverage";
import {
  renderResume,
  selectBullets,
  type CareerRecord,
  type RenderResumeOptions,
  type ResumeSelection,
  type ThemeVocabulary,
} from "@/lib/resume-render/render";
import defaultCareer from "@/lib/resume-render/content/resume.json";
import defaultVocabulary from "@/lib/resume-render/content/themes.json";

/**
 * The model answered, and the answer cannot be trusted to build a document
 * from. Thrown rather than returned, and never downgraded to an empty theme
 * list: a résumé built from garbage themes renders perfectly and is wrong, so
 * the only safe failure is a loud one.
 */
export class TailorResponseError extends Error {
  /** Every raw response, in order, so a caller can see what the model said. */
  readonly responses: string[];

  constructor(message: string, responses: string[]) {
    super(message);
    this.name = "TailorResponseError";
    this.responses = responses;
  }
}

/**
 * Below this share of the page speaking to the posting, the résumé gets a
 * warning attached. Strictly below — a selection landing exactly on the floor
 * has met it. The same `>`-not-`>=` care lib/salary.ts's compensation boundary
 * needs, for the same reason: the comparison is the rule, and a test pins it.
 */
export const MIN_STRENGTH = 0.5;

export interface ThemeResponse {
  themes: string[];
  positioning: string | null;
  unsupported: string[];
  reasoning: string;
}

export type ParseResult =
  | { ok: true; value: ThemeResponse }
  | { ok: false; complaint: string };

/** The signature of lib/model-call's `complete`, narrowed to what this file
 *  uses. Injectable so the tests can drive every branch without a network call
 *  or a mocking library. */
export type CompleteFn = (opts: {
  system: string;
  prompt: string;
  maxTokens?: number;
}) => Promise<string>;

export interface TailorForJobOptions {
  career?: CareerRecord;
  vocabulary?: ThemeVocabulary;
  complete?: CompleteFn;
  /** Passed straight to renderResume — `base`, `margin`, `pageGuides`. */
  render?: RenderResumeOptions;
  /** Bullet id forced first on the first role. selectBullets' own option. */
  lead?: string;
  maxTokens?: number;
}

export interface TailorForJobResult {
  html: string;
  coverage: CoverageReport;
  themes: string[];
  positioning: string | null;
  reasoning: string;
  unsupported: string[];
  selection: ResumeSelection;
  /** Present when the pool cannot honestly answer this posting. Never
   *  suppressed, and never conditional on a caller opting in. */
  warning?: string;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * Validate one model response against the career record and the vocabulary.
 *
 * Returns a COMPLAINT rather than throwing, because the complaint is what the
 * retry sends back to the model — a retry that repeats the original prompt
 * verbatim gives the model no reason to answer differently and just buys the
 * same mistake twice.
 *
 * An unknown theme id is REJECTED, never filtered out. Dropping it silently
 * (what app/actions/resume.ts does today) produces a document themed on
 * whatever survived the filter, with nothing anywhere saying the model asked
 * for something else.
 */
export function parseThemeResponse(
  raw: string,
  career: CareerRecord,
  vocabulary: ThemeVocabulary
): ParseResult {
  let parsed: unknown;
  try {
    parsed = parseJson<unknown>(raw);
  } catch {
    return { ok: false, complaint: "that was not valid JSON. Return the JSON object only, with no prose around it." };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, complaint: "the response was not a JSON object." };
  }
  const body = parsed as Record<string, unknown>;

  if (!isStringArray(body.themes)) {
    return { ok: false, complaint: '"themes" is required and must be an array of theme id strings.' };
  }
  const knownThemes = vocabulary.themes.map((t) => t.id);
  const badThemes = body.themes.filter((id) => knownThemes.indexOf(id) === -1);
  if (badThemes.length > 0) {
    return {
      ok: false,
      complaint: `these are not theme ids in the vocabulary: ${badThemes.join(", ")}. Valid ids are: ${knownThemes.join(", ")}.`,
    };
  }

  const positioning = body.positioning;
  if (positioning !== null && typeof positioning !== "string") {
    return { ok: false, complaint: '"positioning" must be a positioning id string, or null.' };
  }
  if (typeof positioning === "string") {
    const knownPositioning = (career.positioning || []).map((p) => p.id);
    if (knownPositioning.indexOf(positioning) === -1) {
      return {
        ok: false,
        complaint: `"${positioning}" is not a positioning id. Valid ids are: ${knownPositioning.join(", ")}.`,
      };
    }
  }

  if (!isStringArray(body.unsupported)) {
    return {
      ok: false,
      complaint: '"unsupported" is required and must be an array of strings — use [] if the themes cover the posting.',
    };
  }
  if (typeof body.reasoning !== "string") {
    return { ok: false, complaint: '"reasoning" is required and must be a string.' };
  }

  return {
    ok: true,
    value: {
      themes: body.themes,
      positioning: positioning === undefined ? null : positioning,
      unsupported: body.unsupported,
      reasoning: body.reasoning,
    },
  };
}

function labelFor(themeId: string, vocabulary: ThemeVocabulary): string {
  const found = vocabulary.themes.filter((t) => t.id === themeId)[0];
  return found ? found.label : themeId;
}

/**
 * The plain-language sentence that goes with a résumé the pool cannot honestly
 * back. Three independent triggers, and any one alone is enough:
 *
 *   - a theme the posting called for that NO bullet in the pool carries
 *     (`coverage.gaps`), however well the rest of the page scores;
 *   - less than MIN_STRENGTH of the selected bullets speaking to the posting
 *     at all; and
 *   - the posting requiring something no theme in the vocabulary covers
 *     (`unsupported`), however well the page scores.
 *
 * That third trigger is the one that actually catches an off-target posting,
 * and it is not redundant with the other two. `coverage()` can only report on
 * themes the vocabulary HAS a word for, and `strength` measures the page
 * against ITSELF — what share of the rendered bullets carry a theme the model
 * asked for. Both go quiet in the exact case that matters: the model picks the
 * two or three themes it can honestly support, they are supported well, and
 * nothing anywhere notices that the posting's actual subject was never on the
 * list. Measured on a real partner-channel JD: strength 70%, zero gaps, and
 * four unsupported requirements — two of them themes.json's own knownGaps.
 * Without this trigger that résumé went out with no warning at all.
 *
 * An uncomputable strength (`null` — nothing was selected) warns too. It is
 * not evidence of a good match; it is the absence of evidence either way, and
 * a résumé nobody can measure is exactly the one that must not go out silently.
 *
 * Themes are named by LABEL, and the posting's unmet demands are quoted in its
 * own words, because the reader of this sentence is deciding whether to apply —
 * "migration" is a vocabulary key, not information.
 */
export function warningFor(
  report: CoverageReport,
  unsupported: string[],
  vocabulary: ThemeVocabulary
): string | undefined {
  const weak = report.strength === null || report.strength < MIN_STRENGTH;
  if (report.gaps.length === 0 && unsupported.length === 0 && !weak) return undefined;

  const parts: string[] = ["This posting is a stretch for the bullet pool."];

  if (report.gaps.length > 0) {
    parts.push(
      `Nothing in the résumé covers ${report.gaps.map((g) => labelFor(g, vocabulary)).join(", ")}, which this posting asked for.`
    );
  }

  // "on the page", not "in the record": `report` is scoped to the roles
  // renderBody actually draws, so a theme can read thin here while the record
  // holds plenty — that surplus is `poolBeyondRendered`, and naming it is the
  // difference between a dead end and something the reader can act on by
  // raising compressAfter.
  const thin = report.themes.filter((t) => t.support === "thin");
  if (thin.length > 0) {
    const named = thin.map((t) => {
      const label = labelFor(t.theme, vocabulary);
      if (t.poolBeyondRendered === 0) return label;
      const n = t.poolBeyondRendered;
      return `${label} (${n} more supporting bullet${n === 1 ? "" : "s"} sits in a compressed role)`;
    });
    parts.push(
      `Thin evidence on the page for ${named.join(", ")} — fewer than three bullets among the roles this document renders.`
    );
  }

  if (report.strength === null) {
    parts.push("No bullets were selected, so there is nothing to measure the posting against.");
  } else if (weak) {
    parts.push(
      `Only ${Math.round(report.strength * 100)}% of the bullets on the page speak to what this posting asked for.`
    );
  }

  if (unsupported.length > 0) {
    parts.push(`The posting also asks for ${unsupported.join("; ")}, which this record has no evidence for.`);
  }

  if (report.unknown.length > 0) {
    parts.push(`Themes outside the vocabulary were requested: ${report.unknown.join(", ")}.`);
  }

  return parts.join(" ");
}

/**
 * Turn job-description text into a tailored résumé.
 *
 * One model call, or two when the first answer names an id that does not
 * exist. A third is never made: past that, the model is not going to converge
 * and a TailorResponseError is the honest outcome.
 */
export async function tailorForJob(
  jdText: string,
  opts: TailorForJobOptions = {}
): Promise<TailorForJobResult> {
  if (typeof jdText !== "string" || jdText.trim().length === 0) {
    // Refused before the call, not after: classifying an empty posting bills a
    // request to produce themes with nothing behind them, and the résumé that
    // comes back looks exactly as confident as a real one.
    throw new TailorResponseError("A job description is required — nothing was pasted.", []);
  }

  const career = opts.career ?? (defaultCareer as CareerRecord);
  const vocabulary = opts.vocabulary ?? (defaultVocabulary as ThemeVocabulary);
  const call = opts.complete ?? defaultComplete;
  const maxTokens = opts.maxTokens ?? 800;

  const responses: string[] = [];
  let complaint: string | undefined;
  let derived: ThemeResponse | null = null;

  for (let attempt = 0; attempt < 2 && derived === null; attempt++) {
    const { system, prompt } = buildJdThemePrompt(jdText, career, vocabulary, complaint);
    const raw = await call({ system, prompt, maxTokens });
    responses.push(raw);
    const parsed = parseThemeResponse(raw, career, vocabulary);
    if (parsed.ok) derived = parsed.value;
    else complaint = parsed.complaint;
  }

  if (derived === null) {
    throw new TailorResponseError(
      `The model's theme selection could not be used after two attempts: ${complaint}`,
      responses
    );
  }

  const selection = selectBullets(career, {
    themes: derived.themes,
    ...(derived.positioning ? { positioning: derived.positioning } : {}),
    ...(opts.lead ? { lead: opts.lead } : {}),
  });
  // coverageReport, NOT render.js's own coverage(): the latter audits the whole
  // pool, including the roles renderBody compresses to one-line rows. Judging a
  // warning threshold on that number judges a document nobody is looking at —
  // measured on the shipped record, the two disagree by up to 7.6 points, in
  // both directions. See lib/resume-coverage.ts's header.
  const report = coverageReport(career, derived.themes, selection, vocabulary);
  const warning = warningFor(report, derived.unsupported, vocabulary);

  return {
    html: renderResume(career, selection, opts.render),
    coverage: report,
    themes: derived.themes,
    positioning: selection.positioningId,
    reasoning: derived.reasoning,
    unsupported: derived.unsupported,
    selection,
    ...(warning ? { warning } : {}),
  };
}
