import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { FitInputs } from "./fit-inputs";
import {
  aiGtmCompCarveOut,
  buildFitPrompt,
  compFloorLine,
  compScoringClause,
  DEFAULT_DOMAIN_BONUS,
  DEFAULT_MODERATE_TAIL,
  DEFAULT_STRONG_TAIL,
  DEFAULT_TITLE_SCOPE,
  DEFAULT_WEAK_FIT_TAIL,
  formatDollars,
} from "./fit-prompt";
import {
  FIXTURE_BRAIN,
  FIXTURE_EMPTY_BLOCKS,
  FIXTURE_NO_FLOOR,
  FIXTURE_ROLE,
  FIXTURE_WITH_FLOOR,
} from "./__fixtures__/fit-prompt-inputs";

// The same inputs the checked-in fixtures were rendered from — see
// lib/__fixtures__/fit-prompt-inputs.ts. Every field is distinct and
// non-empty, so a builder that renders one value where another belongs fails
// rather than coincidentally matching.
const ROLE = FIXTURE_ROLE;
const BRAIN = FIXTURE_BRAIN;
const NO_FLOOR: FitInputs = FIXTURE_NO_FLOOR;
const WITH_FLOOR: FitInputs = FIXTURE_WITH_FLOOR;
const EMPTY_BLOCKS: FitInputs = FIXTURE_EMPTY_BLOCKS;

/** The section of the prompt between two headings, for position assertions. */
function between(prompt: string, from: string, to: string): string {
  const start = prompt.indexOf(from);
  const end = prompt.indexOf(to);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return prompt.slice(start, end);
}

describe("formatDollars", () => {
  test("groups thousands, at every magnitude the floor plausibly takes", () => {
    // Host-independent by construction — see the note on formatDollars. The
    // old toLocaleString("en-US") rendered these identically on an en-US
    // machine whether or not the locale argument was there, so no test could
    // tell the pinned call from the unpinned one.
    expect(formatDollars(1000)).toBe("$1,000");
    expect(formatDollars(180000)).toBe("$180,000");
    expect(formatDollars(1250000)).toBe("$1,250,000");
  });

  test("leaves figures below a thousand ungrouped", () => {
    expect(formatDollars(999)).toBe("$999");
  });

  test("rounds, so a hand-edited fractional row cannot render '$180,000.5'", () => {
    // The grouping regex assumes an unbroken run of digits; a decimal point
    // makes it group the wrong side. saveCompFloor rejects non-integers, but
    // app_settings is hand-editable.
    expect(formatDollars(180000.4)).toBe("$180,000");
    expect(formatDollars(999.6)).toBe("$1,000");
  });
});

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
    // Whole clauses, not keywords: "cap the score at 3" also appears in a
    // sentence that says the opposite of what it should, and an assertion
    // that matches either one is not pinning anything.
    const clause = compScoringClause(180000);
    expect(clause).toContain(
      "Posted base clearly below that minimum = cap the score at 3 no matter how strong the rest of the fit is"
    );
    // The other half of "scores low rather than disappearing": capped at 3,
    // but not pushed below what the rest of the fit earned.
    expect(clause).toContain(
      "Do not drop it below what the rest of the fit earns; a below-floor role is a real role the candidate may still want to see."
    );
    expect(clause.toLowerCase()).not.toContain("score 1");
  });

  test("a band whose top only reaches the minimum is capped like a below-floor role", () => {
    // Agreement with salaryBucketFor's `base > floor`. Without this bullet a
    // $150,000-$200,000 band at a $200,000 floor is neither "clearly below" nor
    // outside "at or above", so the model scores it 4-5 while the table buckets
    // it "below" and hides it under "Meets minimum". Pinned as whole clauses:
    // the bare word "top" appears elsewhere in the prompt.
    const clause = compScoringClause(180000);
    expect(clause).toContain(
      "- Posted base range whose TOP only reaches that minimum = treat it as below too, and cap at 3 the same way."
    );
    expect(clause).toContain(
      "Reaching the number would take negotiating to the absolute ceiling of the band, which is not meeting a minimum."
    );
  });

  test("does not reward pay above the floor, and 'above' excludes merely reaching it", () => {
    // Asymmetric on purpose. The floor is a minimum, not a ranking signal —
    // otherwise the highest bidder outranks the best-fitting role. Pinned as
    // the whole instruction: "no adjustment" alone survives an edit that
    // reverses the sentence around it.
    expect(compScoringClause(180000)).toContain(
      "- Posted base above the minimum, meaning the top of the range clears it outright = no adjustment. Do not reward pay above the floor."
    );
    // The old wording. "At or above" contradicts the band-top bullet directly:
    // a band topping out AT the minimum satisfies it, so the two bullets would
    // tell the model to cap and not to cap the same role.
    expect(compScoringClause(180000)).not.toContain("at or above");
  });

  test("tells the model not to treat OTE as a base figure", () => {
    // The same rule lib/salary-filter.ts encodes for the /roles filter: OTE
    // bundles commission, so comparing it to a base floor understates the
    // role. Stated in the prompt because the model, unlike the filter, sees
    // the raw string. The bare token "OTE" would also match a sentence
    // telling it to do the opposite.
    expect(compScoringClause(180000)).toContain(
      "OTE bundles commission and is not a base figure — never treat it as one, and never guess a base from it."
    );
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

  test("carries the band-top rule itself, rather than leaving it to the clause above", () => {
    // Read where it sits, inside the rule whose floor of 4 it has to beat. If
    // "below the minimum" is read narrowly here, a band topping out AT the
    // minimum floors at 4 while the table hides it — the same table-versus-
    // score split, reopened by the one rule that outranks the clause.
    expect(aiGtmCompCarveOut(180000)).toContain(
      "or is a range whose top only reaches it, cap at 3 regardless of this rule"
    );
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
    const prompt = buildFitPrompt(ROLE, {
      fitBrain: "Chief Waffle Officer.",
      compFloor: null,
      weakFitTail: DEFAULT_WEAK_FIT_TAIL,
      moderateTail: DEFAULT_MODERATE_TAIL,
      strongTail: DEFAULT_STRONG_TAIL,
      titleScope: DEFAULT_TITLE_SCOPE,
      domainBonus: DEFAULT_DOMAIN_BONUS,
    });
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
    const inputs: FitInputs = {
      fitBrain: BRAIN,
      compFloor: 180000,
      weakFitTail: DEFAULT_WEAK_FIT_TAIL,
      moderateTail: DEFAULT_MODERATE_TAIL,
      strongTail: DEFAULT_STRONG_TAIL,
      titleScope: DEFAULT_TITLE_SCOPE,
      domainBonus: DEFAULT_DOMAIN_BONUS,
    };
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

/**
 * The whole rendered prompt, byte for byte, against a checked-in fixture.
 *
 * The assertions above pin the compensation MECHANICS — conditionality,
 * cap-at-3, where the carve-out sits, 0-means-off. They also pin six section
 * HEADINGS, and that is where they stopped: nothing above notices if a scoring
 * tier, a title-scope bullet or a financial signal is deleted, reworded, or
 * INVERTED. Those bullets are the rubric every score in the table was
 * calibrated against; an edit that silently makes scoring worse (the observed
 * case: flipping "Do not reward pay above the floor" into "Reward pay well
 * above the floor") shipped green against a heading-level guard.
 *
 * So the fixture is the guard, and the six-heading test above is now just its
 * readable summary. A future prompt edit fails here with the changed lines
 * printed, and the fixture is updated deliberately in the same commit — which
 * is the point. Regenerate ONLY after reading the diff:
 *
 *   npx tsx -e 'import {writeFileSync} from "fs";
 *     import {buildFitPrompt} from "./lib/fit-prompt";
 *     import {FIXTURE_ROLE, FIXTURE_NO_FLOOR, FIXTURE_WITH_FLOOR, FIXTURE_EMPTY_BLOCKS}
 *       from "./lib/__fixtures__/fit-prompt-inputs";
 *     writeFileSync("lib/__fixtures__/fit-prompt.no-floor.txt",
 *       buildFitPrompt(FIXTURE_ROLE, FIXTURE_NO_FLOOR));
 *     writeFileSync("lib/__fixtures__/fit-prompt.with-floor.txt",
 *       buildFitPrompt(FIXTURE_ROLE, FIXTURE_WITH_FLOOR));
 *     writeFileSync("lib/__fixtures__/fit-prompt.empty-blocks.txt",
 *       buildFitPrompt(FIXTURE_ROLE, FIXTURE_EMPTY_BLOCKS));'
 *
 * Deliberately not a snapshot library: `toMatchSnapshot` writes a missing
 * snapshot on first run and `-u` rewrites a failing one, so the guard can be
 * silenced by the same reflex that runs the tests.
 */
describe("the rendered prompt, against its fixture", () => {
  const read = (name: string) =>
    readFileSync(path.join(__dirname, "__fixtures__", name), "utf8");

  /**
   * Changed lines, one entry each, so a failure names WHAT moved rather than
   * dumping two 50-line strings side by side. Length is asserted separately
   * first: an inserted line shifts every line after it, and "58 lines, fixture
   * has 57" is the useful sentence in that case.
   */
  function changedLines(actual: string, expected: string): string[] {
    const a = actual.split("\n");
    const e = expected.split("\n");
    const out: string[] = [];
    for (let i = 0; i < Math.max(a.length, e.length); i++) {
      if (a[i] !== e[i]) {
        out.push(
          `line ${i + 1}\n  fixture: ${e[i] ?? "(no such line)"}\n  actual:  ${a[i] ?? "(no such line)"}`
        );
      }
    }
    return out;
  }

  test("with no floor set, matches fit-prompt.no-floor.txt exactly", () => {
    const fixture = read("fit-prompt.no-floor.txt");
    const actual = buildFitPrompt(ROLE, NO_FLOOR);
    expect(actual.split("\n").length).toBe(fixture.split("\n").length);
    expect(changedLines(actual, fixture)).toEqual([]);
  });

  test("with a floor set, matches fit-prompt.with-floor.txt exactly", () => {
    const fixture = read("fit-prompt.with-floor.txt");
    const actual = buildFitPrompt(ROLE, WITH_FLOOR);
    expect(actual.split("\n").length).toBe(fixture.split("\n").length);
    expect(changedLines(actual, fixture)).toEqual([]);
  });

  test("with titleScope and domainBonus both empty, matches fit-prompt.empty-blocks.txt exactly", () => {
    // titleScopeBlock and domainBonusBlock both return "" here — the proof
    // that both blocks vanish cleanly (no bare heading, no dangling carve-out,
    // no doubled blank line) rather than merely that a non-empty default
    // renders correctly.
    const fixture = read("fit-prompt.empty-blocks.txt");
    const actual = buildFitPrompt(ROLE, EMPTY_BLOCKS);
    expect(actual.split("\n").length).toBe(fixture.split("\n").length);
    expect(changedLines(actual, fixture)).toEqual([]);
  });

  test("the two fixtures differ ONLY by the three compensation splices", () => {
    // Guards the fixtures themselves. Two files that had drifted apart for an
    // unrelated reason would still each match their own rendering, and both
    // tests above would pass while the floor quietly changed something else
    // in the prompt.
    const withFloor = read("fit-prompt.with-floor.txt").split("\n");
    const noFloor = read("fit-prompt.no-floor.txt").split("\n");
    const extra = withFloor.filter((l) => !noFloor.includes(l));
    expect(extra.length).toBeGreaterThan(0);
    // The candidate-block floor line, the five-line COMPENSATION block, and
    // the carve-out. Nothing else may appear only in the floor rendering.
    expect(extra).toEqual([
      "- Targets roles paying at least $180,000 base. Below that is a weaker fit unless the equity or building opportunity is exceptional.",
      "COMPENSATION (the candidate stated a minimum base above — apply it):",
      "- Posted base clearly below that minimum = cap the score at 3 no matter how strong the rest of the fit is, and say so in the rationale. Do not drop it below what the rest of the fit earns; a below-floor role is a real role the candidate may still want to see.",
      "- Posted base range whose TOP only reaches that minimum = treat it as below too, and cap at 3 the same way. Reaching the number would take negotiating to the absolute ceiling of the band, which is not meeting a minimum.",
      "- Posted base above the minimum, meaning the top of the range clears it outright = no adjustment. Do not reward pay above the floor.",
      "- No base published, or an OTE / on-target figure only = no adjustment either way. OTE bundles commission and is not a base figure — never treat it as one, and never guess a base from it.",
      "→ If the posted base is below the candidate's stated minimum, or is a range whose top only reaches it, cap at 3 regardless of this rule. The compensation floor overrides this one.",
    ]);
    // And the no-floor rendering adds nothing of its own.
    expect(noFloor.filter((l) => !withFloor.includes(l))).toEqual([]);
  });

  test("empty-blocks differs from with-floor ONLY by the title-scope and domain-bonus text", () => {
    // Same hazard as the test above, for the third fixture: empty-blocks.txt
    // and with-floor.txt could each match their own rendering while having
    // drifted apart from each other for an unrelated reason (e.g. a hand-edit
    // to one file's compensation section). Every line in empty-blocks.txt must
    // also appear in with-floor.txt — nothing in the "both blocks omitted"
    // rendering is content that isn't ALSO in the "both blocks present" one.
    const withFloor = read("fit-prompt.with-floor.txt").split("\n");
    const emptyBlocks = read("fit-prompt.empty-blocks.txt").split("\n");
    expect(emptyBlocks.filter((l) => !withFloor.includes(l))).toEqual([]);
    // And the only lines with-floor has that empty-blocks lacks are the
    // TITLE SCOPE SIGNALS heading + its five bullets, the AI-DRIVEN GTM
    // TRANSFORMATION RULE heading + its three-condition body, and the
    // compensation carve-out line that rides along with it.
    const extra = withFloor.filter((l) => !emptyBlocks.includes(l));
    expect(extra).toEqual([
      "TITLE SCOPE SIGNALS (use these to adjust score):",
      '- "Head of", "VP", "Director" of RevOps / Revenue Operations / GTM Systems / Marketing Operations / GTM Strategy = leadership level, eligible for 4-5 if domain matches',
      '- "GTM Engineer", "GTM Systems", "AI Operations", "AI Ops", "Revenue Systems", "Marketing Ops Architect", "Agentic / Automation" in the title = a direct match IF that is the positioning the candidate describes; score on company tier + scope + AI/building mandate, eligible for 4-5 even as an IC when systems/agentic work and broad ownership are the point',
      "- IC / practitioner builder roles at elite AI-first companies (Anthropic, OpenAI, Google DeepMind, Cursor, Cohere, Mistral, etc.) or hyper-growth B2B SaaS (Series B+) where hands-on GTM systems + agentic AI is the mandate = eligible for 4-5 regardless of title — the building, equity, learning, and impact outweigh the title",
      "- A narrowly-scoped role at a generic small company with no building mandate = cap at 2-3, UNLESS narrow-and-hands-on is what the candidate says they want",
      "- Pure people-management or pure process-admin roles with no systems architecture or AI/building component = lower",
      "AI-DRIVEN GTM TRANSFORMATION RULE (apply when all three are true):",
      "1. The company is an established B2B SaaS / RevTech / MarTech company (PE-backed, growth-stage, or public — not just a tiny startup)",
      '2. The role is explicitly framed as leading an AI transformation of GTM, RevOps, or Marketing Operations — building AI/agentic workflows into the revenue engine, not just "uses AI"',
      "3. The domain is within 1 degree of THE CANDIDATE's background as stated above (adjacent industry, adjacent function, or any vertical where the experience they describe transfers)",
      "→ When all three apply: floor score of 4. This is a mandate to define what AI means for the entire GTM/revenue motion — exactly the kind of mandate the candidate describes wanting.",
      "→ If the domain requires deep vertical expertise the candidate does not claim (pharma, clinical, hardware, heavy regulatory): stay at 3. Real upside but execution risk is high — they would spend year 1 learning the domain rather than building.",
      "→ If the posted base is below the candidate's stated minimum, or is a range whose top only reaches it, cap at 3 regardless of this rule. The compensation floor overrides this one.",
    ]);
  });

  test("neither rendering carries a doubled blank line", () => {
    // A splice that renders "" leaves the newlines around it behind. Harmless
    // to a model, but it is the visible symptom of a seam that assumed its
    // fragment was always non-empty — worth failing on rather than absorbing
    // into the fixture.
    for (const name of [
      "fit-prompt.no-floor.txt",
      "fit-prompt.with-floor.txt",
      "fit-prompt.empty-blocks.txt",
    ]) {
      const lines = read(name).split("\n");
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.every((l, i) => !(l === "" && lines[i - 1] === ""))).toBe(true);
    }
  });

  test("renders every career-specific field it is HANDED, never a module default", () => {
    // Same property pinned for fitBrain above: an implementation that ignored
    // inputs.titleScope/domainBonus and rendered DEFAULT_TITLE_SCOPE /
    // DEFAULT_DOMAIN_BONUS instead would pass every fixture test above (they
    // ARE the defaults) while ignoring a tenant's own text entirely. No .txt
    // fixture for this one — an inline assertion is enough and it cannot drift.
    //
    // The three clause tails are here for the same reason and were missed at
    // first: EVERY other FitInputs construction in the whole suite passes the
    // DEFAULT_* tails, so nothing else in 861 tests can tell "reads the field"
    // apart from "inlines the constant". This assertion is the only thing that
    // can. Any field added to FitInputs belongs in this test.
    const inputs: FitInputs = {
      ...WITH_FLOOR,
      titleScope: "- SYNTHETIC TITLE SCOPE",
      domainBonus: "SYNTHETIC DOMAIN BONUS",
      weakFitTail: "SYNTHETIC WEAK TAIL",
      moderateTail: "SYNTHETIC MODERATE TAIL",
      strongTail: "SYNTHETIC STRONG TAIL",
    };
    const prompt = buildFitPrompt(ROLE, inputs);
    expect(prompt).toContain("- SYNTHETIC TITLE SCOPE");
    expect(prompt).toContain("SYNTHETIC DOMAIN BONUS");
    expect(prompt).toContain("SYNTHETIC WEAK TAIL");
    expect(prompt).toContain("SYNTHETIC MODERATE TAIL");
    expect(prompt).toContain("SYNTHETIC STRONG TAIL");
    expect(prompt).not.toContain(DEFAULT_TITLE_SCOPE);
    expect(prompt).not.toContain(DEFAULT_DOMAIN_BONUS);
    expect(prompt).not.toContain(DEFAULT_WEAK_FIT_TAIL);
    expect(prompt).not.toContain(DEFAULT_MODERATE_TAIL);
    expect(prompt).not.toContain(DEFAULT_STRONG_TAIL);
  });
});
