import { describe, expect, test } from "vitest";

import { buildEnrichPrompt, enrichSystem } from "./enrich-prompt";
import type { ExtractedPage } from "./page-extract";

const PAGE: ExtractedPage = {
  text: "Revenue Operations Manager. Requires 5 years of SQL. Nice to have: Python.",
  links: [],
};

const OPTS = {
  company: "Clay",
  roleTitle: "RevOps Manager",
  page: PAGE,
};

describe("the enrichment prompt asks the posting, and only the posting", () => {
  test("it names the role and the company it is reading for", () => {
    const prompt = buildEnrichPrompt(OPTS);

    expect(prompt).toContain("RevOps Manager");
    expect(prompt).toContain("Clay");
  });

  test("the page text is what it reads from", () => {
    const prompt = buildEnrichPrompt(OPTS);

    expect(prompt).toContain(PAGE.text);
  });

  test("it asks for the four fields the row stores", () => {
    const prompt = buildEnrichPrompt(OPTS);

    for (const field of [
      "requirements",
      "nice_to_haves",
      "department",
      "description_summary",
    ]) {
      expect(prompt).toContain(field);
    }
  });

  // The whole failure mode this backfill exists to avoid: a model that fills
  // gaps from its own knowledge writes fiction into the row, which is worse
  // than leaving it thin.
  test("it forbids inventing what the page does not say", () => {
    expect(buildEnrichPrompt(OPTS).toLowerCase()).toContain("do not invent");
  });

  test("an empty answer is an allowed answer", () => {
    expect(buildEnrichPrompt(OPTS)).toContain("empty");
  });

  // A career-neutrality surface: this prompt is shared by every tenant, so any
  // example vocabulary in it ships one career's words to all of them. That is
  // the class lib/career-neutrality.test.ts exists for and the kind it would
  // miss — its PHRASES list only covers strings extracted into Profile.
  test("no career-specific vocabulary reaches the shared prompt", () => {
    // Neutral inputs: the row's own title and page text obviously carry the
    // tenant's career, so what is under test is the TEMPLATE around them.
    const text = `${enrichSystem()}\n${buildEnrichPrompt({
      company: "A",
      roleTitle: "B",
      page: { text: "", links: [] },
    })}`;

    for (const word of ["GTM", "RevOps", "Salesforce", "Marketo", "engineer", "nurse"]) {
      expect(text).not.toContain(word);
    }
  });

  test("the system prompt demands JSON with no prose around it", () => {
    expect(enrichSystem()).toContain("JSON");
  });
});
