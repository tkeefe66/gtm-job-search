import { describe, expect, test } from "vitest";
import {
  DEFAULT_PROFILE,
  PROFILE_TEXT_MAX_CHARS,
  profileToFitInputs,
  resolveProfile,
} from "./profile";
import {
  DEFAULT_DOMAIN_BONUS,
  DEFAULT_MODERATE_TAIL,
  DEFAULT_STRONG_TAIL,
  DEFAULT_TITLE_SCOPE,
  DEFAULT_WEAK_FIT_TAIL,
} from "./fit-prompt";

describe("DEFAULT_PROFILE", () => {
  test("carries today's shipped text, so the switch is a no-op", () => {
    expect(DEFAULT_PROFILE.searchSubject).toBe("go-to-market and revenue operations");
    expect(DEFAULT_PROFILE.querySubject).toBe("revenue operations");
    expect(DEFAULT_PROFILE.candidatePersona).toBe(
      "GTM Systems / RevOps / Marketing Ops leader and AI practitioner-builder"
    );
    expect(DEFAULT_PROFILE.buildingConcept).toBe("building GTM systems and agentic AI workflows");
    expect(DEFAULT_PROFILE.buildingUpside).toBe("systems/AI-building upside");
    expect(DEFAULT_PROFILE.weakFitTail).toBe(DEFAULT_WEAK_FIT_TAIL);
    expect(DEFAULT_PROFILE.moderateTail).toBe(DEFAULT_MODERATE_TAIL);
    expect(DEFAULT_PROFILE.strongTail).toBe(DEFAULT_STRONG_TAIL);
    expect(DEFAULT_PROFILE.titleScope).toBe(DEFAULT_TITLE_SCOPE);
    expect(DEFAULT_PROFILE.domainBonus).toBe(DEFAULT_DOMAIN_BONUS);
  });

  test("its fit brain is EMPTY — a career is never a fallback", () => {
    expect(DEFAULT_PROFILE.fitBrain).toBe("");
  });

  test("its hiring signal reproduces today's funding search", () => {
    expect(DEFAULT_PROFILE.hiringSignal.name).toBe("funding rounds");
    expect(DEFAULT_PROFILE.hiringSignal.qualifier).toBe("Series B and above");
    // Verbatim from the pre-genericisation hardcoded Discover system prompt.
    // Restoring this closed a documented behaviour change: the qualifier
    // alone stated the floor without ruling out what sat below it.
    expect(DEFAULT_PROFILE.hiringSignal.exclusions).toBe(
      "seed, pre-seed, and Series A rounds"
    );
    expect(DEFAULT_PROFILE.hiringSignal.hasRecency).toBe(true);
    expect(DEFAULT_PROFILE.hiringSignal.sources).toContain("TechCrunch");
  });

  test("its hiring-signal sources are the 10-source superset, in the system prompt's order", () => {
    // discover.ts states its sources TWICE and the two lists differ: the system
    // prompt names ten, the user prompt eight. One field renders both, so it
    // carries the superset — see Ruling 3 in the SDD ledger. Do not trim this
    // to the user prompt's eight; that list cannot reproduce the system prompt.
    expect(DEFAULT_PROFILE.hiringSignal.sources).toEqual([
      "TechCrunch", "Crunchbase", "The Information", "Bloomberg", "Forbes",
      "VentureBeat", "Reuters", "WSJ", "Business Insider", "X/Twitter",
    ]);
  });
});

describe("resolveProfile", () => {
  test("a non-object repairs to the defaults", () => {
    for (const raw of [null, undefined, "profile", 7, []]) {
      expect(resolveProfile(raw)).toEqual(DEFAULT_PROFILE);
    }
  });

  test("returns a fresh object every time, never the module constant", () => {
    const a = resolveProfile(null);
    const b = resolveProfile(null);
    expect(a).not.toBe(DEFAULT_PROFILE);
    expect(a.hiringSignal).not.toBe(DEFAULT_PROFILE.hiringSignal);
    expect(a.hiringSignal.sources).not.toBe(DEFAULT_PROFILE.hiringSignal.sources);
    a.hiringSignal.sources.push("mutated");
    expect(b.hiringSignal.sources).not.toContain("mutated");
    expect(DEFAULT_PROFILE.hiringSignal.sources).not.toContain("mutated");
  });

  test("keeps the fields it understands and repairs only the rest", () => {
    const p = resolveProfile({
      searchSubject: "mechanical design and manufacturing engineering",
      querySubject: 42,
    });
    expect(p.searchSubject).toBe("mechanical design and manufacturing engineering");
    expect(p.querySubject).toBe(DEFAULT_PROFILE.querySubject);
  });

  test("a missing fit brain repairs to empty, NOT to a career", () => {
    expect(resolveProfile({}).fitBrain).toBe("");
    expect(resolveProfile({ fitBrain: 12 }).fitBrain).toBe("");
  });

  test("an empty domainBonus is a VALUE, because the block is optional", () => {
    expect(resolveProfile({ domainBonus: "" }).domainBonus).toBe("");
  });

  test("an empty clause tail repairs — the prompt would render a dangling dash", () => {
    const p = resolveProfile({ weakFitTail: "", moderateTail: "   ", strongTail: null });
    expect(p.weakFitTail).toBe(DEFAULT_WEAK_FIT_TAIL);
    expect(p.moderateTail).toBe(DEFAULT_MODERATE_TAIL);
    expect(p.strongTail).toBe(DEFAULT_STRONG_TAIL);
  });

  test("prose where a list belongs repairs to the default list", () => {
    const p = resolveProfile({ hiringSignal: { sources: "TechCrunch and Bloomberg" } });
    expect(p.hiringSignal.sources).toEqual(DEFAULT_PROFILE.hiringSignal.sources);
  });

  test("a list with non-string members drops them rather than rendering [object Object]", () => {
    const p = resolveProfile({
      hiringSignal: { name: "contract awards", sources: ["Defense News", 5, null, "GovWin"] },
    });
    expect(p.hiringSignal.sources).toEqual(["Defense News", "GovWin"]);
  });

  test("over-long text is truncated — the brain is paid once per scored role", () => {
    const long = "x".repeat(PROFILE_TEXT_MAX_CHARS + 500);
    const p = resolveProfile({ fitBrain: long, titleScope: long });
    expect(p.fitBrain.length).toBe(PROFILE_TEXT_MAX_CHARS);
    expect(p.titleScope.length).toBe(PROFILE_TEXT_MAX_CHARS);
  });

  test("hasRecency is a boolean, and a non-boolean does not read as true", () => {
    expect(resolveProfile({ hiringSignal: { hasRecency: "yes" } }).hiringSignal.hasRecency).toBe(true);
    expect(resolveProfile({ hiringSignal: { hasRecency: false } }).hiringSignal.hasRecency).toBe(false);
  });
});

describe("profileToFitInputs", () => {
  test("carries every scoring field across, plus the floor", () => {
    const profile = resolveProfile({
      fitBrain: "A mechanical engineer.",
      weakFitTail: "W",
      moderateTail: "M",
      strongTail: "S",
      titleScope: "- T",
      domainBonus: "D",
    });
    expect(profileToFitInputs(profile, 180000)).toEqual({
      fitBrain: "A mechanical engineer.",
      compFloor: 180000,
      weakFitTail: "W",
      moderateTail: "M",
      strongTail: "S",
      titleScope: "- T",
      domainBonus: "D",
    });
  });

  test("a null floor stays null", () => {
    expect(profileToFitInputs(DEFAULT_PROFILE, null).compFloor).toBeNull();
  });
});

describe("hiringSignal.exclusions", () => {
  // optionalText, not text: a signal that rules nothing out is a real answer,
  // and a `text`-style resolver would quietly restore the funding default for
  // a nurse whose profile deliberately left this blank.
  test('an explicit "" is kept, not replaced by the default', () => {
    const p = resolveProfile({ hiringSignal: { exclusions: "" } });
    expect(p.hiringSignal.exclusions).toBe("");
  });

  test("a stored value wins", () => {
    const p = resolveProfile({ hiringSignal: { exclusions: "re-competes" } });
    expect(p.hiringSignal.exclusions).toBe("re-competes");
  });

  test("a missing field falls back to the shipped default", () => {
    const p = resolveProfile({ hiringSignal: { name: "contract awards" } });
    expect(p.hiringSignal.exclusions).toBe(
      DEFAULT_PROFILE.hiringSignal.exclusions
    );
  });

  test("a wrong-typed value falls back rather than coercing", () => {
    const p = resolveProfile({ hiringSignal: { exclusions: ["a", "b"] } });
    expect(p.hiringSignal.exclusions).toBe(
      DEFAULT_PROFILE.hiringSignal.exclusions
    );
  });
});
