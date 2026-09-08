import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { buildJdThemePrompt } from "@/lib/jd-theme-prompt";
import type { CareerRecord, ThemeVocabulary } from "@/lib/resume-render/render";
import careerJson from "@/lib/resume-render/content/resume.json";
import vocabularyJson from "@/lib/resume-render/content/themes.json";

const career = careerJson as CareerRecord;
const vocabulary = vocabularyJson as ThemeVocabulary;

const JD = `Director, Revenue Operations
Own the pipeline architecture end to end: forecasting, attribution, and the
Salesforce/Marketo stack behind them. Lead a team of four analysts.`;

function fixture(name: string): string {
  return readFileSync(path.join(__dirname, "__fixtures__", name), "utf8");
}

function rendered(complaint?: string): string {
  const { system, prompt } = buildJdThemePrompt(JD, career, vocabulary, complaint);
  return `${system}\n\n===== PROMPT =====\n\n${prompt}`;
}

describe("buildJdThemePrompt", () => {
  // The fixture pins what the model actually receives, not just the builder
  // that produces it — the same guard lib/__fixtures__/fit-prompt.*.txt gives
  // the fit prompt. Regenerating one blesses whatever the code emits, so a
  // commit that touches only a fixture is a red flag, not a refresh.
  it("renders the first-attempt prompt byte-identically", () => {
    expect(rendered()).toBe(fixture("jd-theme-prompt.txt"));
  });

  it("renders the retry prompt byte-identically", () => {
    expect(rendered('these are not theme ids in the vocabulary: revops.')).toBe(
      fixture("jd-theme-prompt.retry.txt")
    );
  });

  // Mutation this catches: rendering the theme block from `t.label` alone. The
  // model is told to answer with IDS, so a list that shows only labels asks for
  // a value it never displayed — and every answer would then be rejected.
  it("offers every theme by the id the response must use", () => {
    const { system } = buildJdThemePrompt(JD, career, vocabulary);
    for (const t of vocabulary.themes) expect(system).toContain(`- ${t.id} (${t.label})`);
  });

  // Mutation this catches: dropping the knownGaps block. The model cannot
  // report a gap it was never told about, so without this the `unsupported`
  // field goes quietly empty for exactly the postings that need it most.
  it("names what the record has no evidence for", () => {
    const { system } = buildJdThemePrompt(JD, career, vocabulary);
    for (const absent of vocabulary.knownGaps.absent) expect(system).toContain(absent);
  });

  // Mutation this catches: threading the complaint into `system` instead of
  // `prompt`. Both reach the model, but the retry then differs from the first
  // attempt only in a field the caller's own test asserts on the prompt.
  it("puts the complaint in the retry prompt", () => {
    const { prompt } = buildJdThemePrompt(JD, career, vocabulary, "revops is not a theme id");
    expect(prompt).toContain("revops is not a theme id");
    expect(buildJdThemePrompt(JD, career, vocabulary).prompt).not.toContain("rejected");
  });
});
