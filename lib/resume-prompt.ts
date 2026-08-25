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
Company: ${job.company}${optionalLine("Seniority", job.seniority)}${optionalLine("Department", job.department)}${optionalLine("Key skills", job.keySkills)}${optionalLine("Salary range", job.salaryRange)}${optionalLine("Company description", job.companyDescription)}${optionalLine("Fit summary", job.fitSummary)}
`;

  return { system, prompt };
}
