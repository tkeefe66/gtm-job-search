// Builds the raw-JD theme-derivation prompt.
//
// The sibling of lib/resume-prompt.ts's buildThemePrompt, and deliberately a
// SECOND builder rather than a widening of that one. They answer different
// questions: buildThemePrompt classifies a job this app already tracks, from the
// structured fields ingest stored (title, seniority, requirements); this one
// classifies a job description someone pasted, where the only input is prose and
// there is no row to fall back on. Their response contracts differ too — this
// one asks for a positioning id, the JD's unmet demands, and a sentence of
// reasoning, none of which the stored-job path has any use for.
//
// The invariant both share: the model NEVER writes, edits, or paraphrases résumé
// copy. It picks ids out of a fixed vocabulary. Every sentence that reaches the
// page comes verbatim from content/resume.json via render.js's selectBullets, so
// a bullet on the page is a bullet the candidate can defend in an interview.
import type { CareerRecord, ThemeVocabulary } from "@/lib/resume-render/render";

function themeBlock(vocabulary: ThemeVocabulary): string {
  return vocabulary.themes
    .map((t) => `- ${t.id} (${t.label}) — signals: ${t.jdSignals.join(", ")}`)
    .join("\n");
}

function positioningBlock(career: CareerRecord): string {
  return (career.positioning || [])
    .map((p) => `- ${p.id} — ${p.tagline}`)
    .join("\n");
}

/** The vocabulary's own record of what this career has no honest evidence for.
 *  Naming it in the prompt is what lets the model report a stretch instead of
 *  inventing a theme to cover one — the model cannot report a gap it was never
 *  told existed. */
function absentBlock(vocabulary: ThemeVocabulary): string {
  const absent = (vocabulary.knownGaps && vocabulary.knownGaps.absent) || [];
  if (absent.length === 0) return "";
  return `\n\nThis candidate has NO evidence for the following. If the posting leads on any of them, list it in "unsupported" — never stretch a theme to cover it:\n${absent
    .map((a) => `- ${a}`)
    .join("\n")}`;
}

export function buildJdThemePrompt(
  jdText: string,
  career: CareerRecord,
  vocabulary: ThemeVocabulary,
  /** What was wrong with the previous attempt. Present only on a retry. */
  complaint?: string
): { system: string; prompt: string } {
  const system = `You classify a job description against a fixed vocabulary of one candidate's career themes. You do NOT write, edit, summarise, or paraphrase résumé content — you only choose ids from the lists below. Any prose you invent would be discarded.

THEMES (choose from these ids only, most relevant to this posting first):
${themeBlock(vocabulary)}

POSITIONING (choose exactly one id, or null if none fits better than the others):
${positioningBlock(career)}${absentBlock(vocabulary)}

Respond with strict JSON and nothing else:
{"themes": ["<theme id>", ...], "positioning": "<positioning id>" | null, "unsupported": ["<what the posting requires that no theme above covers>", ...], "reasoning": "<one or two sentences on why these themes>"}

Rules:
- Include a theme only where the posting shows real signal for it. Omit the rest. An empty list is a valid answer.
- Never invent a theme id or a positioning id. Ids not on the lists above are rejected.
- "unsupported" is where honesty lives: name, in the posting's own words, anything it requires that the themes cannot speak to. An empty list means the themes cover the posting.
- All four keys are required.`;

  const correction = complaint
    ? `\n\nYour previous answer was rejected: ${complaint}\nAnswer again, using only ids from the lists in the instructions.`
    : "";

  return {
    system,
    prompt: `JOB DESCRIPTION\n${jdText.trim()}${correction}\n`,
  };
}
