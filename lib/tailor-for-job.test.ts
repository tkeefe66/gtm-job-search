import { describe, expect, it } from "vitest";
import {
  MIN_STRENGTH,
  parseThemeResponse,
  tailorForJob,
  warningFor,
  TailorResponseError,
} from "@/lib/tailor-for-job";
import type { CareerRecord, ThemeVocabulary } from "@/lib/resume-render/render";
import type { CoverageReport } from "@/lib/resume-coverage";
import careerJson from "@/lib/resume-render/content/resume.json";
import vocabularyJson from "@/lib/resume-render/content/themes.json";

const career = careerJson as CareerRecord;
const vocabulary = vocabularyJson as ThemeVocabulary;

/** A recording stand-in for lib/model-call's `complete`. Returns each canned
 *  response in turn; running past the end is itself a failure worth seeing. */
function scriptedComplete(responses: string[]) {
  const calls: { system: string; prompt: string }[] = [];
  const fn = async (opts: { system: string; prompt: string }) => {
    calls.push({ system: opts.system, prompt: opts.prompt });
    if (calls.length > responses.length) {
      throw new Error(`model called ${calls.length} times, only ${responses.length} scripted`);
    }
    return responses[calls.length - 1];
  };
  return { fn, calls };
}

function response(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    themes: ["ops", "data"],
    positioning: "gtm",
    unsupported: [],
    reasoning: "Pipeline architecture and reporting lead the posting.",
    ...over,
  });
}

const JD =
  "Director of Revenue Operations. Own pipeline architecture, forecasting, and the RevOps team.";

function coverageStub(over: Partial<CoverageReport> = {}): CoverageReport {
  return {
    themes: [],
    gaps: [],
    unknown: [],
    strength: 1,
    overlayBullets: 0,
    editedBullets: 0,
    ...over,
  };
}

describe("parseThemeResponse", () => {
  it("accepts a well-formed response", () => {
    const r = parseThemeResponse(response(), career, vocabulary);
    expect(r.ok).toBe(true);
  });

  // Mutation this catches: validating theme ids with `.filter(id => valid.has(id))`
  // — the silent drop app/actions/resume.ts does today. Under that mutation the
  // response is accepted with themes ["ops"], so `ok` stays true and nothing
  // names the bad id.
  it("rejects an unknown theme id instead of dropping it", () => {
    const r = parseThemeResponse(response({ themes: ["ops", "revops"] }), career, vocabulary);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.complaint).toContain("revops");
  });

  // Mutation this catches: skipping validation of `positioning`, which
  // selectBullets would then silently ignore, falling back to the deterministic
  // pick while the caller is told the model chose "gtm-leader".
  it("rejects an unknown positioning id", () => {
    const r = parseThemeResponse(response({ positioning: "gtm-leader" }), career, vocabulary);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.complaint).toContain("gtm-leader");
  });

  // Mutation this catches: treating `positioning` as required. Null is the
  // model's legitimate "no strong preference", and selectBullets handles it.
  it("accepts a null positioning", () => {
    const r = parseThemeResponse(response({ positioning: null }), career, vocabulary);
    expect(r.ok).toBe(true);
    expect(r.ok === true && r.value.positioning).toBeNull();
  });

  // Mutation this catches: `themes: parsed.themes || []`, which turns a
  // response that omitted the field into a legal empty selection.
  it("rejects a response with no themes field", () => {
    const r = parseThemeResponse(
      JSON.stringify({ positioning: "gtm", unsupported: [], reasoning: "x" }),
      career,
      vocabulary
    );
    expect(r.ok).toBe(false);
  });

  // Mutation this catches: defaulting `unsupported` to []. The field is the
  // only channel for "the JD asked for something no theme covers", so a
  // response that omitted it is not the same as one that reported nothing.
  it("rejects a non-array unsupported", () => {
    const r = parseThemeResponse(response({ unsupported: "none" }), career, vocabulary);
    expect(r.ok).toBe(false);
  });

  // Mutation this catches: letting parseJson's SyntaxError escape uncaught
  // instead of becoming a retryable complaint.
  it("reports unparseable output as a complaint, not a throw", () => {
    const r = parseThemeResponse("I think this role wants RevOps.", career, vocabulary);
    expect(r.ok).toBe(false);
  });

  // Mutation this catches: rejecting an empty theme list. A JD that genuinely
  // matches nothing is a real answer, and the coverage warning is what says so.
  it("accepts an empty theme list", () => {
    const r = parseThemeResponse(response({ themes: [] }), career, vocabulary);
    expect(r.ok).toBe(true);
  });
});

describe("warningFor", () => {
  // Mutation this catches: `strength < MIN_STRENGTH` becoming `<=`. The sibling
  // test below only proves a value BELOW the floor warns, so `<=` passes it.
  it("stays silent at exactly the strength floor", () => {
    expect(warningFor(coverageStub({ strength: MIN_STRENGTH }), [], vocabulary)).toBeUndefined();
  });

  it("warns just below the strength floor", () => {
    expect(warningFor(coverageStub({ strength: MIN_STRENGTH - 0.01 }), [], vocabulary)).toBeDefined();
  });

  // Mutation this catches: keying the warning on strength alone. A JD can ask
  // for a theme the pool has no bullet for while the rest of the page still
  // scores well, and that gap is exactly what must not be swallowed.
  it("warns on an absent theme even when strength is perfect", () => {
    const w = warningFor(
      coverageStub({
        strength: 1,
        gaps: ["migration"],
        themes: [
          { theme: "migration", pool: 0, selected: 0, roles: [], support: "absent", poolBeyondRendered: 0 },
        ],
      }),
      [],
      vocabulary
    );
    expect(w).toBeDefined();
  });

  // Mutation this catches: interpolating raw theme ids. "migration" is a
  // vocabulary key, not a sentence a person reads.
  it("names an absent theme by its label, not its id", () => {
    const w = warningFor(coverageStub({ strength: 1, gaps: ["migration"] }), [], vocabulary);
    expect(w).toContain("Migrations and consolidation");
  });

  // Mutation this catches: dropping `unsupported` from the composed text. It is
  // the only place the JD's own words appear, so without it the warning cannot
  // say what the posting wanted.
  it("names what the posting asked for that no theme covers", () => {
    const w = warningFor(coverageStub({ strength: 0.2 }), ["partner channel strategy"], vocabulary);
    expect(w).toContain("partner channel strategy");
  });

  // Mutation this catches: guarding with `strength != null && strength < MIN`,
  // which goes silent on the one case where nothing could be measured at all.
  it("warns when strength could not be computed", () => {
    expect(warningFor(coverageStub({ strength: null }), [], vocabulary)).toBeDefined();
  });

  // Mutation this catches: triggering on `gaps.length || weak` alone — which is
  // what a partner-channel posting slips through. Every theme the model picked
  // is well supported, so strength reads high and gaps is empty; the entire
  // signal that the posting is wrong for this candidate lives in `unsupported`,
  // because coverage() can only see themes the vocabulary HAS a word for.
  // Measured: a real channel JD scored 70% with four unsupported requirements.
  it("warns on an unsupported requirement even when the page scores well", () => {
    const w = warningFor(coverageStub({ strength: 1, gaps: [] }), ["partner/channel sales"], vocabulary);
    expect(w).toBeDefined();
    expect(w).toContain("partner/channel sales");
  });
});

describe("tailorForJob", () => {
  it("returns page text copied verbatim from the career record", async () => {
    const { fn } = scriptedComplete([response()]);
    const out = await tailorForJob(JD, { complete: fn, career, vocabulary });
    // The anchor bullet of the first role, character for character.
    expect(out.html).toContain(career.roles[0].bullets[0].text);
  });

  // Mutation this catches: tailorForJob filtering the selection by theme after
  // selectBullets returns. selectBullets guarantees each role's priority-1
  // bullet survives; a second filter here would silently break that, and the
  // 'team' bullet carries neither requested theme.
  it("keeps each rendered role's priority-1 bullet even when it is off-theme", async () => {
    const { fn } = scriptedComplete([response({ themes: ["migration"], positioning: null })]);
    const out = await tailorForJob(JD, { complete: fn, career, vocabulary });
    const rendered = career.roles.slice(0, career.rules.compressAfter ?? career.roles.length);
    for (const role of rendered) {
      const anchor = role.bullets.slice().sort((a, b) => a.priority - b.priority)[0];
      expect(out.html).toContain(anchor.text);
    }
  });

  // Mutation this catches: ignoring the model's positioning and letting
  // selectBullets pick. Themes ["ops","data"] score the "gtm" variant highest,
  // so only a model choice of "ai" can distinguish the two paths.
  it("uses the positioning the model chose, not the theme-match default", async () => {
    const { fn } = scriptedComplete([response({ themes: ["ops", "data"], positioning: "ai" })]);
    const out = await tailorForJob(JD, { complete: fn, career, vocabulary });
    expect(out.positioning).toBe("ai");
    const ai = career.positioning.find((p) => p.id === "ai")!;
    expect(out.html).toContain(ai.tagline);
  });

  // Mutation this catches: silently dropping the invalid id and returning after
  // one call — the behaviour app/actions/resume.ts has today. Under it the
  // model is called once, not twice.
  it("retries once when the model returns an unknown theme id", async () => {
    const { fn, calls } = scriptedComplete([
      response({ themes: ["ops", "revops"] }),
      response({ themes: ["ops", "data"] }),
    ]);
    const out = await tailorForJob(JD, { complete: fn, career, vocabulary });
    expect(calls).toHaveLength(2);
    expect(out.themes).toEqual(["ops", "data"]);
  });

  // Mutation this catches: sending the identical prompt on the retry. A model
  // never told what was wrong has no reason to answer differently, which makes
  // the retry a second charge for the same mistake.
  it("tells the model what was wrong on the retry", async () => {
    const { fn, calls } = scriptedComplete([response({ themes: ["revops"] }), response()]);
    await tailorForJob(JD, { complete: fn, career, vocabulary });
    expect(calls[1].prompt).toContain("revops");
    expect(calls[1].prompt).not.toBe(calls[0].prompt);
  });

  // Mutation this catches: a retry loop that gives up by returning an empty
  // selection. A résumé built from no themes renders fine and is wrong.
  it("throws when the invalid id survives the retry", async () => {
    const { fn } = scriptedComplete([
      response({ themes: ["revops"] }),
      response({ themes: ["revops"] }),
    ]);
    await expect(tailorForJob(JD, { complete: fn, career, vocabulary })).rejects.toThrow(
      TailorResponseError
    );
  });

  it("throws when the model never returns JSON", async () => {
    const { fn } = scriptedComplete(["not json", "still not json"]);
    await expect(tailorForJob(JD, { complete: fn, career, vocabulary })).rejects.toThrow(
      TailorResponseError
    );
  });

  // Mutation this catches: proceeding with a blank JD, which bills a model call
  // to classify nothing and returns a confident generic résumé.
  it("refuses a blank job description without calling the model", async () => {
    const { fn, calls } = scriptedComplete([response()]);
    await expect(tailorForJob("   \n  ", { complete: fn, career, vocabulary })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  // Mutation this catches: computing coverage against the themes the model
  // returned but never attaching the warning to the result — the caller then
  // has a low-strength résumé and no sentence saying so.
  it("attaches a warning when the selection barely speaks to the posting", async () => {
    const { fn } = scriptedComplete([
      response({ themes: ["migration"], positioning: null, unsupported: ["pricing and packaging"] }),
    ]);
    const out = await tailorForJob(JD, { complete: fn, career, vocabulary });
    expect(out.coverage.strength!).toBeLessThan(MIN_STRENGTH);
    expect(out.warning).toBeDefined();
    expect(out.warning).toContain("pricing and packaging");
  });

  // Mutation this catches: warning unconditionally, which trains the reader to
  // ignore it and makes the third-JD signal worthless.
  it("attaches no warning when the pool answers the posting", async () => {
    const { fn } = scriptedComplete([response({ themes: ["ops", "leadership", "data"] })]);
    const out = await tailorForJob(JD, { complete: fn, career, vocabulary });
    expect(out.coverage.strength!).toBeGreaterThanOrEqual(MIN_STRENGTH);
    expect(out.warning).toBeUndefined();
  });

  // Mutation this catches: reporting render.js's own coverage() instead of
  // lib/resume-coverage's coverageReport. coverage() audits the whole POOL —
  // selectBullets fills `bullets` for all 12 roles while renderBody draws only
  // the first `compressAfter`. For these themes that is 0.8261 against 0.7500:
  // a warning threshold read off the first number is judging a document with
  // seven bullets on it that nobody can see.
  it("measures strength against the roles the document actually renders", async () => {
    const { fn } = scriptedComplete([
      response({ themes: ["ops", "data", "leadership", "migration"], positioning: null }),
    ]);
    const out = await tailorForJob(JD, { complete: fn, career, vocabulary });
    expect(out.coverage.strength!).toBeCloseTo(0.75, 4);
    expect(out.coverage.strength!).not.toBeCloseTo(0.8261, 4);
  });

  // Mutation this catches: keeping render.js's CoverageReport, which has no
  // such field. Support sitting in a compressed role is real evidence the page
  // is not showing, and it is the one gap the reader can actually act on.
  it("reports supporting bullets stranded in compressed roles", async () => {
    const { fn } = scriptedComplete([response({ themes: ["migration"], positioning: null })]);
    const out = await tailorForJob(JD, { complete: fn, career, vocabulary });
    const migration = out.coverage.themes.find((t) => t.theme === "migration")!;
    expect(migration.poolBeyondRendered).toBe(2);
  });

  it("passes the job description through to the prompt", async () => {
    const { fn, calls } = scriptedComplete([response()]);
    await tailorForJob(JD, { complete: fn, career, vocabulary });
    expect(calls[0].prompt).toContain(JD);
  });
});
