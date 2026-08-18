import { describe, expect, test } from "vitest";
import { draftFromGenerated, payloadFrom, toList } from "./onboarding-draft";
import type { GeneratedProfile } from "./onboarding-prompt";
import type { OnboardingAnswers } from "./profile";

const ANSWERS: OnboardingAnswers = {
  mode: "questions",
  current: "Machinist",
  wanted: "CNC programmer",
  where: "Denver",
  dealbreakers: "No night shift",
  resume: "",
};

/**
 * Every field carries a DISTINCT value on purpose — two fields sharing text
 * would let a transposition (`weakFitTail: draft.moderateTail`) round-trip
 * clean, the same reason lib/__fixtures__/fit-prompt-inputs.ts gives for its
 * own fixture. Lists carry more than one already-trimmed, non-blank entry
 * each, so join("\n") then toList's split+trim+filter is provably lossless
 * for this fixture.
 */
const GENERATED: GeneratedProfile = {
  fitBrain: "fit-brain text",
  weakFitTail: "weak-tail text",
  moderateTail: "moderate-tail text",
  strongTail: "strong-tail text",
  titleScope: "title-scope text",
  domainBonus: "domain-bonus text",
  searchSubject: "search-subject text",
  querySubject: "query-subject text",
  stackFamilyIntro: "stack-family-intro text",
  candidatePersona: "candidate-persona text",
  buildingConcept: "building-concept text",
  buildingUpside: "building-upside text",
  hiringSignal: {
    name: "signal-name text",
    sources: ["Source A", "Source B"],
    qualifier: "signal-qualifier text",
    hasRecency: true,
    extraFields: ["field_one", "field_two"],
  },
  toolsAreWeak: false,
  titles: ["Title One", "Title Two"],
  locations: ["Location One"],
  stackTerms: ["Stack One", "Stack Two", "Stack Three"],
  locationRule: "location-rule text",
};

describe("draftFromGenerated / payloadFrom round trip", () => {
  test("reconstructs the generated profile exactly, with the caller's own answers spliced in", () => {
    // The whole point: draftFromGenerated then payloadFrom must return
    // exactly what went in, field for field. A dropped field is a compile
    // error (the return types are exact), but a SWAPPED one — this project's
    // core failure mode, a wrong value that looks exactly like a correct one
    // — is not, and this single toEqual is what catches it.
    const draft = draftFromGenerated(GENERATED);
    const result = payloadFrom(draft, ANSWERS);
    expect(result).toEqual({ ...GENERATED, answers: ANSWERS });
  });

  test("answers come from the CALLER, never from the generated object", () => {
    // GeneratedProfile has no `answers` field at all (Task 8's review — it is
    // the input, not an output). A caller that accidentally spread the
    // generated object over the answers parameter would lose this distinction
    // silently; asserting the exact ANSWERS object survives, rather than just
    // "some object", is what would catch that.
    const draft = draftFromGenerated(GENERATED);
    const result = payloadFrom(draft, ANSWERS);
    expect(result.answers).toEqual(ANSWERS);
  });
});

describe("toList", () => {
  test("trims and drops blank lines", () => {
    expect(toList("  a  \n\nb\n   \nc")).toEqual(["a", "b", "c"]);
  });

  test("empty input is an empty list", () => {
    expect(toList("")).toEqual([]);
  });
});
