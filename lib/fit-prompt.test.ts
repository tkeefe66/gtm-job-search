import { describe, expect, test } from "vitest";
import type { FitInputs } from "./fit-inputs";
import {
  aiGtmCompCarveOut,
  buildFitPrompt,
  compFloorLine,
  compScoringClause,
  type FitPromptRole,
} from "./fit-prompt";

// Every field distinct and non-empty, so a builder that renders one value
// where another belongs fails rather than coincidentally matching.
const ROLE: FitPromptRole = {
  company: "Acme",
  role_title: "Head of RevOps",
  company_description: "B2B SaaS for widgets",
  key_skills: "Salesforce, Marketo",
  fit_summary: "Broad GTM systems ownership",
  department: "Revenue",
  location: "Denver, CO",
  salary_range: "$210,000 - $240,000",
  arr: "$380M+ ARR",
  exit_signal: "PE exit planned",
  backer: "Centerbridge Partners",
};

const BRAIN = "A candidate who does GTM systems.";
const NO_FLOOR: FitInputs = { fitBrain: BRAIN, compFloor: null };
const WITH_FLOOR: FitInputs = { fitBrain: BRAIN, compFloor: 180000 };

/** The section of the prompt between two headings, for position assertions. */
function between(prompt: string, from: string, to: string): string {
  const start = prompt.indexOf(from);
  const end = prompt.indexOf(to);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return prompt.slice(start, end);
}

describe("compFloorLine", () => {
  test("states the floor with thousands separators", () => {
    // "$180000" in a prompt is a figure the model has to squint at; the app's
    // own UI renders the same setting as "$180,000".
    const line = compFloorLine(180000);
    expect(line).toContain("$180,000");
    expect(line).not.toContain("$180000");
  });

  test("is a bullet appended to the candidate block, not a replacement for it", () => {
    // Appended, never merged into the stored fit brain: the floor is its own
    // setting with its own reset, and folding it into the brain text would
    // make a floor change look like a fit-brain edit.
    expect(compFloorLine(180000).startsWith("\n- ")).toBe(true);
  });

  test("says below-floor is WEAKER, never disqualifying", () => {
    // The spec's promise is that a below-floor role scores low rather than
    // disappearing. Wording that told the model to reject outright would
    // reintroduce the filter through the prompt.
    const line = compFloorLine(180000).toLowerCase();
    expect(line).toContain("at least");
    expect(line).toContain("weaker fit");
    expect(line).not.toContain("do not consider");
    expect(line).not.toContain("exclude");
  });

  test("no floor set renders nothing at all", () => {
    // Not "no minimum stated" or "$0": with no floor there is no candidate
    // preference to state, and inventing one would have the model reason about
    // a number the user never set.
    expect(compFloorLine(null)).toBe("");
  });

  test("0 means off, exactly as null does", () => {
    // Matches saveCompFloor (rejects 0), the /roles filter, and every other
    // truthiness check on this value. A stored 0 reaching here as "at least $0"
    // would be a floor that every role on earth clears — noise in every prompt.
    expect(compFloorLine(0)).toBe("");
    expect(compFloorLine(-1)).toBe("");
  });
});

describe("compScoringClause", () => {
  test("caps a below-floor role rather than sinking it", () => {
    const clause = compScoringClause(180000);
    expect(clause).toContain("cap the score at 3");
    // "Cap", not "score 1": the role stays visible and honestly rated on
    // everything else. This is the difference between scoring low and
    // disappearing.
    expect(clause.toLowerCase()).not.toContain("score 1");
  });

  test("does not reward pay above the floor", () => {
    // Asymmetric on purpose. The floor is a minimum, not a ranking signal —
    // otherwise the highest bidder outranks the best-fitting role.
    expect(compScoringClause(180000)).toContain("at or above the minimum = no adjustment");
  });

  test("tells the model not to treat OTE as a base figure", () => {
    // The same rule lib/salary-filter.ts encodes for the /roles filter: OTE
    // bundles commission, so comparing it to a base floor understates the
    // role. Stated in the prompt because the model, unlike the filter, sees
    // the raw string.
    expect(compScoringClause(180000)).toContain("OTE");
  });

  test("no floor set means no compensation instruction at all", () => {
    // With no minimum in the prompt, "below the candidate's minimum" names
    // nothing — an instruction referencing a value that was never supplied
    // invites the model to invent one.
    expect(compScoringClause(null)).toBe("");
    expect(compScoringClause(0)).toBe("");
  });
});

describe("aiGtmCompCarveOut", () => {
  test("caps the AI-GTM floor of 4 at 3 when the base is below the minimum", () => {
    // THE defect this task closes. The AI-GTM rule's three conditions say
    // nothing about pay, so without this line a below-floor role at an
    // established B2B SaaS company with an AI mandate still floors at 4 — and
    // "a below-floor role scores low rather than disappearing" silently fails.
    const carve = aiGtmCompCarveOut(180000);
    expect(carve).toContain("cap at 3");
    expect(carve).toContain("regardless of this rule");
  });

  test("no floor set means no carve-out", () => {
    expect(aiGtmCompCarveOut(null)).toBe("");
    expect(aiGtmCompCarveOut(0)).toBe("");
  });
});

describe("buildFitPrompt", () => {
  test("renders the posting's compensation verbatim", () => {
    // Verbatim, unparsed. The model sees what the employer wrote; nothing in
    // the scoring path re-derives a number from it.
    expect(buildFitPrompt(ROLE, NO_FLOOR)).toContain("$210,000 - $240,000");
  });

  test("an unpriced posting says 'not listed', never null or undefined", () => {
    // These interpolate straight into the prompt. "Posted compensation: null"
    // is a sentence the model will reason about.
    const prompt = buildFitPrompt({ ...ROLE, salary_range: "" }, NO_FLOOR);
    expect(prompt).toContain("not listed");
    expect(prompt).not.toContain("undefined");
    expect(prompt).not.toContain(": null");
  });

  test("carries every scoring input the caller supplies", () => {
    // A regression guard on the prompt itself: this text moved out of
    // app/actions/parse-role.ts, and a dropped line here degrades every score
    // silently — scoreFit renders a missing field as "unknown" rather than
    // failing. Values, not field names, so a transposition also fails.
    const prompt = buildFitPrompt(ROLE, NO_FLOOR);
    const values = [
      ROLE.company,
      ROLE.role_title,
      ROLE.company_description,
      ROLE.key_skills,
      ROLE.fit_summary,
      ROLE.department,
      ROLE.location,
      ROLE.salary_range,
      ROLE.arr as string,
      ROLE.exit_signal as string,
      ROLE.backer as string,
    ];
    expect(values.length).toBe(11);
    expect(values.every((v) => prompt.includes(v))).toBe(true);
  });

  test("missing financial signals render as words, not as blanks", () => {
    const prompt = buildFitPrompt(
      { ...ROLE, arr: undefined, exit_signal: undefined, backer: undefined },
      NO_FLOOR
    );
    expect(prompt).toContain("ARR: unknown");
    expect(prompt).toContain("Backer / investor: unknown");
    expect(prompt).toContain("Exit signal: none mentioned");
  });

  test("renders the fit brain it is HANDED, never a module default", () => {
    // Same property lib/crawler.test.ts pins for buildExtractionPrompt: an
    // implementation that ignored `inputs` and imported DEFAULT_FIT_BRAIN
    // would pass every other assertion while ignoring the user's edits.
    const prompt = buildFitPrompt(ROLE, { fitBrain: "Chief Waffle Officer.", compFloor: null });
    expect(prompt).toContain("Chief Waffle Officer.");
    expect(prompt).not.toContain("Tom Keefe");
    expect(prompt).not.toContain(BRAIN);
  });

  test("the floor lands in the CANDIDATE block, not in the ROLE block", () => {
    // It is a candidate preference, not a fact about the posting. Rendered
    // under ROLE it would read as something the employer published.
    const prompt = buildFitPrompt(ROLE, WITH_FLOOR);
    const candidate = between(prompt, "CANDIDATE:", "ROLE:");
    expect(candidate).toContain("$180,000");
    expect(candidate).toContain(BRAIN);
    const role = between(prompt, "ROLE:", "SCORING GUIDE:");
    expect(role).not.toContain("$180,000");
  });

  test("the floor does not mutate the stored fit brain", () => {
    // Appended at prompt-assembly time. If this ever merged into the brain,
    // a floor change would be indistinguishable from a fit-brain edit — and
    // would survive a "reset fit brain to default".
    const inputs: FitInputs = { fitBrain: BRAIN, compFloor: 180000 };
    buildFitPrompt(ROLE, inputs);
    expect(inputs.fitBrain).toBe(BRAIN);
  });

  test("with a floor set, the guide and the AI-GTM carve-out are both present", () => {
    // Both, not either. The clause alone loses to the floor-4 rule; the
    // carve-out alone leaves the guide with no compensation instruction.
    const prompt = buildFitPrompt(ROLE, WITH_FLOOR);
    expect(prompt).toContain(compScoringClause(180000));
    expect(prompt).toContain(aiGtmCompCarveOut(180000));
  });

  test("the carve-out sits inside the AI-GTM rule it overrides", () => {
    // Position is the whole point. Anywhere else in the prompt, the rule's
    // "floor score of 4" is read without its exception attached, which is
    // exactly how the two floors ended up contradicting each other.
    const prompt = buildFitPrompt(ROLE, WITH_FLOOR);
    const rule = prompt.indexOf("AI-DRIVEN GTM TRANSFORMATION RULE");
    const floorOf4 = prompt.indexOf("floor score of 4");
    const carve = prompt.indexOf("regardless of this rule");
    expect(rule).toBeGreaterThan(-1);
    expect(floorOf4).toBeGreaterThan(rule);
    expect(carve).toBeGreaterThan(floorOf4);
    // And before the closing instructions, so it is still part of the rule.
    expect(carve).toBeLessThan(prompt.indexOf("Return a JSON object with:"));
  });

  test("the compensation clause sits in the SCORING GUIDE, before the signal blocks", () => {
    const prompt = buildFitPrompt(ROLE, WITH_FLOOR);
    const guide = between(prompt, "SCORING GUIDE:", "TITLE SCOPE SIGNALS");
    expect(guide).toContain("cap the score at 3");
  });

  test("with no floor set, the prompt says nothing about compensation limits", () => {
    // The posting's own pay still renders — that is posting data, useful
    // context either way. What must not appear is a minimum the user never set.
    const prompt = buildFitPrompt(ROLE, NO_FLOOR);
    expect(prompt).toContain("$210,000 - $240,000");
    expect(prompt).not.toContain("at least $");
    expect(prompt).not.toContain("stated minimum");
    expect(prompt).not.toContain("cap the score at 3");
    expect(prompt).not.toContain("regardless of this rule");
  });

  test("keeps the rubric the scores are calibrated against", () => {
    // Roles already in the table were scored against these blocks. Losing one
    // in the move out of parse-role.ts would re-baseline every future score
    // against a different rubric with nothing to flag it.
    const prompt = buildFitPrompt(ROLE, NO_FLOOR);
    const sections = [
      "SCORING GUIDE:",
      "TITLE SCOPE SIGNALS",
      "FINANCIAL SIGNALS",
      "AI-DRIVEN GTM TRANSFORMATION RULE",
      "score (integer 1-5)",
      "rationale (string",
    ];
    expect(sections.length).toBe(6);
    expect(sections.every((s) => prompt.includes(s))).toBe(true);
  });
});
