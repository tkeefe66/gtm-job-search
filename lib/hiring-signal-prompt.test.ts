import { describe, expect, test } from "vitest";
import {
  buildHiringSignalPrompt,
  hiringSignalSystem,
  joinSources,
} from "./hiring-signal-prompt";
import { DEFAULT_CRITERIA, dateContextLine } from "./search-criteria";
import { DEFAULT_PROFILE } from "./profile";

const D = DEFAULT_PROFILE;
const NOW = new Date("2026-08-17T12:00:00.000Z");

describe("joinSources", () => {
  test("Oxford-comma joins, matching the shipped 10-source list exactly", () => {
    expect(joinSources(D.hiringSignal.sources)).toBe(
      "TechCrunch, Crunchbase, The Information, Bloomberg, Forbes, VentureBeat, " +
        "Reuters, WSJ, Business Insider, and X/Twitter"
    );
  });

  test("two sources join with a bare 'and', no comma", () => {
    expect(joinSources(["A", "B"])).toBe("A and B");
  });

  test("one source is unchanged", () => {
    expect(joinSources(["Solo"])).toBe("Solo");
  });

  test("zero sources is empty", () => {
    expect(joinSources([])).toBe("");
  });
});

// See the RULING comment at the top of lib/hiring-signal-prompt.ts: full
// literal byte-identity to the pre-Task-13 hardcoded prompt is not
// achievable from HiringSignal's five fields (its `qualifier` is the five
// words "Series B and above" — it does not carry the old prompt's round-tier
// breakdown or exclusion clause), and reproducing that detail verbatim in a
// template every profile now shares would put venture vocabulary back for
// every non-funding tenant, which is what this task exists to remove.
//
// What these tests DO pin, exactly like every other builder in this
// directory: the DEFAULT profile — today's real, shipped tenant — renders
// through the new signal-driven template to a fully deterministic string,
// captured here so any accidental drift in the wording shows up as a test
// diff rather than a silent prompt change. And Ruling 3 (the SDD ledger):
// the system prompt's 10-source list and the user prompt's 10-source list
// are now the SAME field, so the user prompt names two more publications
// than it did before this task (Business Insider, X/Twitter) — a deliberate,
// documented behavior change, not an oversight.
describe("hiringSignalSystem", () => {
  test("renders the default (funding) profile deterministically", () => {
    const sources = joinSources(D.hiringSignal.sources);
    const expected =
      `You are a funding rounds analyst. Your job is to find every employer ` +
      `showing this signal for the given period: funding rounds — do not ` +
      `curate down to a short list, capture all notable ones. Search ` +
      `multiple sources: ${sources}. Focus exclusively on Series B and ` +
      `above. Exclude seed, pre-seed, and Series A rounds. ` +
      `Prioritize completeness — it is better to return 20 results ` +
      `than to miss a major one. Return ONLY valid JSON, no markdown, no ` +
      `preamble.`;
    expect(hiringSignalSystem(D.hiringSignal)).toBe(expected);
  });

  // FIX 1, round 2. Round 0 ("find every significant ${name}") and round 1
  // ("find all significant ${name}") each put a determiner directly against
  // `signal.name` and each broke on one of the three probe names — "every"
  // is wrong for a plural name, "all" is wrong for the singular standing
  // designation. `signal.name` is per-tenant free text; its grammatical
  // number cannot be known, so no determiner choice works for all of it.
  //
  // This construction ("every employer showing this signal: ${name}") never
  // puts a determiner against `signal.name` at all — "every" quantifies
  // "employer", and `signal.name` sits in an appositive slot after the
  // colon, where singular and plural both read correctly. Pinned here
  // against exact renderings of all three probe names, not asserted in
  // prose — the previous two rounds both shipped an unverified prose claim
  // about grammar, which is exactly the defect class this project keeps
  // producing.
  describe("reads correctly regardless of signal.name's grammatical number", () => {
    const cases: [string, string, boolean][] = [
      ["funding rounds", "plural — the shipped default", true],
      ["large defence contract awards", "plural — Probe A", true],
      ["Magnet Recognition Program designation", "singular — Probe C, hasRecency:false", false],
    ];

    for (const [name, label, hasRecency] of cases) {
      test(label, () => {
        const signal = {
          name,
          sources: ["Source A"],
          qualifier: "the qualifying tier",
          // "" so these cases keep pinning ONLY the grammatical-number
          // construction they exist for — an exclusion clause here would
          // change three expected strings for an unrelated reason.
          exclusions: "",
          hasRecency,
          extraFields: [],
        };
        const periodClause = hasRecency ? " for the given period" : "";
        const expected =
          `You are a ${name} analyst. Your job is to find every employer ` +
          `showing this signal${periodClause}: ${name} — do not curate down ` +
          `to a short list, capture all notable ones. Search multiple ` +
          `sources: Source A. Focus exclusively on the qualifying tier. ` +
          `Prioritize completeness — it is better to return 20 results than ` +
          `to miss a major one. Return ONLY valid JSON, no markdown, no ` +
          `preamble.`;
        expect(hiringSignalSystem(signal)).toBe(expected);
      });
    }
  });

  test("carries every one of the 10 shipped sources — the Ruling 3 superset", () => {
    const rendered = hiringSignalSystem(D.hiringSignal);
    for (const source of D.hiringSignal.sources) {
      expect(rendered).toContain(source);
    }
  });

  test("drops 'for the given period' when hasRecency is false", () => {
    const standing = { ...D.hiringSignal, hasRecency: false };
    const rendered = hiringSignalSystem(standing);
    expect(rendered).not.toContain("for the given period");
    expect(rendered).toContain("You are a funding rounds analyst.");
  });

  // BLOCKER 5. lib/onboarding-prompt.ts explicitly allows an empty
  // `qualifier` ("when every instance counts"), and this splice site used to
  // render "Focus exclusively on ." — dangling punctuation with no clause
  // before it. qualifierSentence must omit the whole clause instead.
  test("an empty qualifier omits the clause cleanly, with no dangling '.'", () => {
    const signal = {
      name: "large defence contract awards",
      sources: ["Source A"],
      qualifier: "",
      exclusions: "",
      hasRecency: true,
      extraFields: [],
    };
    const rendered = hiringSignalSystem(signal);
    expect(rendered).not.toContain("Focus exclusively on");
    expect(rendered).not.toContain(" .");
    expect(rendered).not.toContain("  ");
    expect(rendered).toBe(
      "You are a large defence contract awards analyst. Your job is to find " +
        "every employer showing this signal for the given period: large " +
        "defence contract awards — do not curate down to a short list, " +
        "capture all notable ones. Search multiple sources: Source A. " +
        "Prioritize completeness — it is better to return 20 results than " +
        "to miss a major one. Return ONLY valid JSON, no markdown, no preamble."
    );
  });

  test("renders a synthetic signal's own name/qualifier/sources, never the shipped defaults", () => {
    const synthetic = {
      name: "SYNTHETIC CONTRACT AWARDS",
      sources: ["Synthetic Trade Press", "Synthetic Registry"],
      qualifier: "SYNTHETIC QUALIFIER TIER",
      exclusions: "",
      hasRecency: true,
      extraFields: ["synthetic_value"],
    };
    const rendered = hiringSignalSystem(synthetic);
    expect(rendered).toContain("SYNTHETIC CONTRACT AWARDS");
    expect(rendered).toContain("Synthetic Trade Press");
    expect(rendered).toContain("Synthetic Registry");
    expect(rendered).toContain("SYNTHETIC QUALIFIER TIER");
    expect(rendered).not.toContain("Series B");
    expect(rendered).not.toContain("TechCrunch");
    expect(rendered).not.toContain("funding rounds");
  });
});

describe("buildHiringSignalPrompt", () => {
  test("renders the default (funding) profile deterministically, with a period", () => {
    const period = "in the past 7 days";
    const rendered = buildHiringSignalPrompt({
      signal: D.hiringSignal,
      criteria: DEFAULT_CRITERIA,
      period,
      focus: "",
      now: NOW,
    });
    const sources = joinSources(D.hiringSignal.sources);
    const expected =
      `Search ${sources} for every employer showing this signal: funding ` +
      `rounds, announced ${period}. Only include Series B and above. ` +
      `Exclude seed, pre-seed, and Series A rounds. Do ` +
      `multiple searches to ensure ` +
      `completeness — vary the query wording, e.g. "Series B and above ` +
      `funding rounds ${period}" and "funding rounds ${period}". Return up ` +
      `to 20 results — do not cut the list short. ${dateContextLine(NOW)} ` +
      `IMPORTANT location preference (soft, for ranking — do not ` +
      `hard-exclude): prioritize companies consistent with the location ` +
      `rule the roles being sought follow: ${DEFAULT_CRITERIA.locationRule} ` +
      `For each, return a JSON array of objects with these exact fields: company (string), ` +
      `tagline (string), careers_url (string, best guess careers page URL ` +
      `or empty string), headquarters (string, city and state e.g. "San ` +
      `Francisco, CA" or "Remote" or "New York, NY"), location (string, ` +
      `WHERE the funding rounds actually happened — the specific site, ` +
      `facility, or region named in the signal, which may differ from ` +
      `headquarters), signal (string, one legible sentence describing what ` +
      `happened, e.g. "Won $2.1B USAF sustainment contract" or "Raised ` +
      `$400M Series D led by a16z"), extras (a JSON object with these ` +
      `additional fields, all strings: raised, stage, lead_investor, ` +
      `founded, traction, category). Return ONLY the JSON array.`;
    expect(rendered).toBe(expected);
  });

  test("a search-term focus prefixes the prompt, unchanged from before this task", () => {
    const rendered = buildHiringSignalPrompt({
      signal: D.hiringSignal,
      criteria: DEFAULT_CRITERIA,
      period: "in the past 7 days",
      focus: `Focus your search specifically on: "widgets". `,
      now: NOW,
    });
    expect(rendered.startsWith(`Focus your search specifically on: "widgets". Search`)).toBe(true);
  });

  // Same number-agreement bug class as hiringSignalSystem (FIX 1, round 2),
  // found here while auditing this file for it — "Search ... for ALL
  // ${name} announced ..." put a determiner against per-tenant free text of
  // unknown grammatical number. Restructured the same way; verified against
  // the singular probe name here too, not just the plural default above.
  test("the search clause reads correctly for a singular signal name", () => {
    const rendered = buildHiringSignalPrompt({
      signal: {
        name: "Magnet Recognition Program designation",
        sources: ["Source A"],
        qualifier: "the qualifying tier",
        exclusions: "",
        hasRecency: true,
        extraFields: [],
      },
      criteria: DEFAULT_CRITERIA,
      period: "in the past 7 days",
      focus: "",
      now: NOW,
    });
    expect(rendered.startsWith(
      "Search Source A for every employer showing this signal: " +
        "Magnet Recognition Program designation, announced in the past 7 days. " +
        "Only include the qualifying tier."
    )).toBe(true);
  });

  // BINDING 4. hasRecency:false means no period clause anywhere in the
  // prompt, and the model is asked for CURRENT holders of the property
  // rather than announcements in a window — Probe C (Magnet hospitals)
  // proved this path returns named employers, not sector articles.
  test("with period null, there is no period clause and no dateContextLine", () => {
    const rendered = buildHiringSignalPrompt({
      signal: D.hiringSignal,
      criteria: DEFAULT_CRITERIA,
      period: null,
      focus: "",
      now: NOW,
    });
    expect(rendered).toContain("current holders of this property");
    expect(rendered).not.toContain("announced");
    expect(rendered).not.toContain("in the past");
    expect(rendered).not.toContain(dateContextLine(NOW));
  });

  test("extras clause is omitted entirely when extraFields is empty", () => {
    const rendered = buildHiringSignalPrompt({
      signal: { ...D.hiringSignal, extraFields: [] },
      criteria: DEFAULT_CRITERIA,
      period: "in the past 7 days",
      focus: "",
      now: NOW,
    });
    expect(rendered).not.toContain("extras (a JSON object");
    // ...but the fixed core survives.
    expect(rendered).toContain('signal (string, one legible sentence');
  });

  // BLOCKER 5. Both the "Only include ." dangling-period splice site and the
  // exampleQueries leading-space splice site (a billed search-query string
  // like `" large defence contract awards in the past 7 days"`) must render
  // cleanly when qualifier is "".
  test("an empty qualifier omits 'Only include' and leaves no leading space in the example query", () => {
    const signal = {
      name: "large defence contract awards",
      sources: ["Source A"],
      qualifier: "",
      exclusions: "",
      hasRecency: true,
      extraFields: [],
    };
    const period = "in the past 7 days";
    const rendered = buildHiringSignalPrompt({
      signal,
      criteria: DEFAULT_CRITERIA,
      period,
      focus: "",
      now: NOW,
    });
    // Scoped to the searchClause substring, not the whole prompt — the
    // location-preference sentence legitimately starts with "Only include"
    // (it comes from criteria.locationRule, unrelated to signal.qualifier),
    // so a whole-prompt "not.toContain('Only include')" would false-positive
    // on that unrelated text.
    expect(rendered).toContain(
      `Search Source A for every employer showing this signal: ${signal.name}, announced ${period}. Do multiple searches`
    );
    // A leading space inside the quoted example would render as `e.g. " ...`
    // (quote immediately followed by a space) — the exact bug this guards.
    expect(rendered).not.toContain('e.g. " ');
    expect(rendered).toContain(`e.g. "${signal.name} ${period}" and "${signal.name} ${period}".`);
  });

  test("renders a synthetic signal's own values, never the shipped defaults", () => {
    const synthetic = {
      name: "SYNTHETIC CONTRACT AWARDS",
      sources: ["Synthetic Trade Press"],
      qualifier: "SYNTHETIC QUALIFIER TIER",
      exclusions: "",
      hasRecency: true,
      extraFields: ["synthetic_value_field"],
    };
    const rendered = buildHiringSignalPrompt({
      signal: synthetic,
      criteria: DEFAULT_CRITERIA,
      period: "in the past 7 days",
      focus: "",
      now: NOW,
    });
    expect(rendered).toContain("SYNTHETIC CONTRACT AWARDS");
    expect(rendered).toContain("Synthetic Trade Press");
    expect(rendered).toContain("SYNTHETIC QUALIFIER TIER");
    expect(rendered).toContain("synthetic_value_field");
    expect(rendered).not.toContain("Series B");
    expect(rendered).not.toContain("TechCrunch");
    expect(rendered).not.toContain("funding rounds");
  });
});

// The exclusion clause restores what the genericisation pass dropped: the old
// hardcoded prompt told the model both where to aim ("Series B and above") and
// what to throw away ("exclude seed, pre-seed, and Series A rounds"), and only
// the first survived. These pin the seam, which is where the guarded-splice
// pattern in this file fails — a dangling " ." or a doubled space.
describe("exclusions", () => {
  const base = {
    name: "contract awards",
    sources: ["Source A"],
    qualifier: "over $50M",
    exclusions: "task orders and re-competes",
    hasRecency: true,
    extraFields: [],
  };

  test("renders after the qualifier in the system prompt", () => {
    expect(hiringSignalSystem(base)).toContain(
      "Focus exclusively on over $50M. Exclude task orders and re-competes. Prioritize"
    );
  });

  test("renders after the qualifier in the windowed user prompt", () => {
    const out = buildHiringSignalPrompt({
      signal: base,
      criteria: DEFAULT_CRITERIA,
      period: "in the past 7 days",
      focus: "",
      now: NOW,
    });
    expect(out).toContain(
      "Only include over $50M. Exclude task orders and re-competes. Do multiple"
    );
  });

  test("renders in the standing-property user prompt too", () => {
    const out = buildHiringSignalPrompt({
      signal: { ...base, hasRecency: false },
      criteria: DEFAULT_CRITERIA,
      period: null,
      focus: "",
      now: NOW,
    });
    expect(out).toContain(
      "current holders of this property: contract awards. Only include over " +
        "$50M. Exclude task orders and re-competes. Do multiple"
    );
  });

  // The seam. Both optional clauses empty must leave ONE space between the
  // sentences either side — not two, and no orphaned "Exclude .".
  test("vanishes cleanly when empty, alongside an empty qualifier", () => {
    const bare = { ...base, qualifier: "", exclusions: "" };
    const out = hiringSignalSystem(bare);
    expect(out).toContain("Source A. Prioritize completeness");
    expect(out).not.toContain("Exclude");
    expect(out).not.toContain("  ");
  });

  test("an empty exclusion does not disturb a present qualifier", () => {
    const out = hiringSignalSystem({ ...base, exclusions: "" });
    expect(out).toContain("Focus exclusively on over $50M. Prioritize");
    expect(out).not.toContain("  ");
  });
});
