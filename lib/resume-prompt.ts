// Builds the theme-derivation prompt: given a job's stored summary fields
// and the checked-in theme vocabulary (content/themes.json), asks the model
// for an ordered list of theme ids — nothing more. The model never sees or
// produces résumé text; lib/resume-render/render.js's selectBullets() does
// the actual bullet selection from those themes, deterministically. See
// docs/superpowers/specs/2026-08-24-resume-builder-design.md, "Tailoring
// call."
import type { ThemeVocabulary } from "@/lib/resume-render/render";

export interface JobSummaryFields {
  roleTitle: string;
  company: string;
  keySkills: string | null;
  fitSummary: string | null;
  seniority: string | null;
  department: string | null;
  salaryRange: string | null;
  companyDescription: string | null;
  /**
   * What the posting itself says it requires, from the `posting` jsonb
   * (lib/posting-detail.ts). Empty when nobody has read the posting — which was
   * the state of EVERY row until this was wired: the column existed, ingest and
   * the backfill filled it, and this prompt could not see it.
   */
  requirements: string[];
  /** Stated preferences. Kept separate because they do not disqualify. */
  niceToHaves: string[];
}

/** A list renders as one labelled line, or nothing at all — the same rule
 *  optionalLine follows, for the same reason: an empty "Requirements:" reads to
 *  the model as a posting that requires nothing. */
function optionalList(label: string, values: string[]): string {
  if (values.length === 0) return "";
  return `\n${label}: ${values.join("; ")}`;
}

/** A missing field OMITS its whole line rather than rendering an empty or
 *  null placeholder — same convention lib/fit-prompt.ts's titleScopeBlock/
 *  domainBonusBlock use. */
function optionalLine(label: string, value: string | null): string {
  if (!value) return "";
  return `\n${label}: ${value}`;
}

function vocabularyBlock(vocabulary: ThemeVocabulary): string {
  return vocabulary.themes
    .map((t) => `- ${t.id} (${t.label}): ${t.jdSignals.join(", ")}`)
    .join("\n");
}

export function buildThemePrompt(
  job: JobSummaryFields,
  vocabulary: ThemeVocabulary
): { system: string; prompt: string } {
  const system = `You classify a job posting against a fixed vocabulary of career themes. You do not write résumé content — you only pick which of the following themes this posting calls for, ranked most relevant first. Choose only from this list; never invent a theme id.

${vocabularyBlock(vocabulary)}

Respond with strict JSON: {"themes": ["<id>", "<id>", ...]}. Include only themes with real signal in the posting — omit any with no support. If nothing matches, return {"themes": []}.`;

  const prompt = `JOB POSTING
Title: ${job.roleTitle}
Company: ${job.company}${optionalLine("Seniority", job.seniority)}${optionalLine("Department", job.department)}${optionalLine("Key skills", job.keySkills)}${optionalLine("Salary range", job.salaryRange)}${optionalLine("Company description", job.companyDescription)}${optionalLine("Fit summary", job.fitSummary)}${optionalList("Requirements", job.requirements)}${optionalList("Nice to have (not required)", job.niceToHaves)}
`;

  return { system, prompt };
}
