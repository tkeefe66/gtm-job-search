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
      `You are a funding rounds analyst. Your job is to find all significant ` +
      `funding rounds for the given period — do not curate down to a short ` +
      `list, capture all notable ones. Search multiple sources: ${sources}. ` +
      `Focus exclusively on Series B and above. Prioritize completeness — it ` +
      `is better to return 20 results than to miss a major one. Return ONLY ` +
      `valid JSON, no markdown, no preamble.`;
    expect(hiringSignalSystem(D.hiringSignal)).toBe(expected);
  });

  // FIX 1 (review round 1): "find every significant funding rounds" put a
  // singular determiner in front of a plural signal name. "all" reads
  // correctly for every probed signal — funding rounds, contract awards,
  // plant openings, a standing designation — where "every" would not.
  test("says 'find all significant', not 'find every significant'", () => {
    const rendered = hiringSignalSystem(D.hiringSignal);
    expect(rendered).toContain("find all significant funding rounds");
    expect(rendered).not.toContain("find every significant");
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

  test("renders a synthetic signal's own name/qualifier/sources, never the shipped defaults", () => {
    const synthetic = {
      name: "SYNTHETIC CONTRACT AWARDS",
      sources: ["Synthetic Trade Press", "Synthetic Registry"],
      qualifier: "SYNTHETIC QUALIFIER TIER",
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
      `Search ${sources} for ALL funding rounds announced ${period}. Only ` +
      `include Series B and above. Do multiple searches to ensure ` +
      `completeness — vary the query wording, e.g. "Series B and above ` +
      `funding rounds ${period}" and "funding rounds ${period}". Return up ` +
      `to 20 results — do not cut the list short. ${dateContextLine(NOW)} ` +
      `IMPORTANT location preference (soft, for ranking — do not ` +
      `hard-exclude): prioritize companies that hire remotely or have a ` +
      `Denver/Colorado presence. For reference, the roles being sought ` +
      `follow this rule: ${DEFAULT_CRITERIA.locationRule} For each, return a ` +
      `JSON array of objects with these exact fields: company (string), ` +
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

  test("renders a synthetic signal's own values, never the shipped defaults", () => {
    const synthetic = {
      name: "SYNTHETIC CONTRACT AWARDS",
      sources: ["Synthetic Trade Press"],
      qualifier: "SYNTHETIC QUALIFIER TIER",
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
