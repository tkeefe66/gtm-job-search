// The GeneratedProfile <-> editable-draft <-> save-payload transforms for
// Step 4 of the onboarding wizard.
//
// Moved OUT of components/Onboarding.tsx (a review finding on this task) for
// the sharpest reason this codebase has: these three functions carry the
// "the user's own answers must survive a re-run" guarantee (payloadFrom takes
// `answers` as its own parameter rather than spreading it off the generated
// object, which omits it on purpose), and the compiler alone does not catch
// every way that guarantee can break. A MISSING field is a compile error; a
// SWAPPED one is not — `weakFitTail: draft.moderateTail` typechecks and ships
// silently, and a swapped scoring field is this project's core failure mode: a
// wrong value that looks exactly like a correct one. Out here, a round-trip
// test in lib/onboarding-draft.test.ts pins the whole mapping in one
// assertion; nothing in components/*.tsx can be reached by this repo's test
// suite (vitest runs with no jsdom) at all.
//
// NO import that reaches `pg`. components/Onboarding.tsx imports this module
// at RUNTIME. lib/onboarding-prompt.ts and lib/profile.ts are both safe (see
// their own header comments) — this file adds nothing beyond their types plus
// plain string/array reshaping.

import type { GeneratedProfile } from "@/lib/onboarding-prompt";
import type { HiringSignal, OnboardingAnswers, Profile } from "@/lib/profile";

/** The editable form of a generated profile — every list joined to lines, so
 *  each field binds to one textarea the way titles/locations/stackTerms do on
 *  /settings. */
export interface ProfileDraft {
  fitBrain: string;
  weakFitTail: string;
  moderateTail: string;
  strongTail: string;
  titleScope: string;
  domainBonus: string;
  searchSubject: string;
  querySubject: string;
  stackFamilyIntro: string;
  candidatePersona: string;
  buildingConcept: string;
  buildingUpside: string;
  hiringSignalName: string;
  hiringSignalSources: string;
  hiringSignalQualifier: string;
  hiringSignalExclusions: string;
  hiringSignalHasRecency: boolean;
  hiringSignalExtraFields: string;
  toolsAreWeak: boolean;
  titles: string;
  locations: string;
  stackTerms: string;
  locationRule: string;
}

/** Textarea lines to a list — trimmed, blanks dropped. The server normalizes
 *  again (validateList, inside saveProfile), so this only has to be good
 *  enough to preview and to send; it does not have to be the final word. */
export const toList = (text: string) =>
  text
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

export function draftFromGenerated(g: GeneratedProfile): ProfileDraft {
  return {
    fitBrain: g.fitBrain,
    weakFitTail: g.weakFitTail,
    moderateTail: g.moderateTail,
    strongTail: g.strongTail,
    titleScope: g.titleScope,
    domainBonus: g.domainBonus,
    searchSubject: g.searchSubject,
    querySubject: g.querySubject,
    stackFamilyIntro: g.stackFamilyIntro,
    candidatePersona: g.candidatePersona,
    buildingConcept: g.buildingConcept,
    buildingUpside: g.buildingUpside,
    hiringSignalName: g.hiringSignal.name,
    hiringSignalSources: g.hiringSignal.sources.join("\n"),
    hiringSignalQualifier: g.hiringSignal.qualifier,
    hiringSignalExclusions: g.hiringSignal.exclusions,
    hiringSignalHasRecency: g.hiringSignal.hasRecency,
    hiringSignalExtraFields: g.hiringSignal.extraFields.join("\n"),
    toolsAreWeak: g.toolsAreWeak,
    titles: g.titles.join("\n"),
    locations: g.locations.join("\n"),
    stackTerms: g.stackTerms.join("\n"),
    locationRule: g.locationRule,
  };
}

/** The draft, in the shape both saveProfile and scoreFit need. Structurally a
 *  `Profile & GeneratedProfile` — saveProfile's own required type — AND
 *  assignable to plain `Profile` for profileToFitInputs, since it is a
 *  superset. `answers` comes from the CALLER's own state, never spread from
 *  the generated object: GeneratedProfile omits it on purpose (Task 8's
 *  review), so spreading only the draft would overwrite the user's stored
 *  answers and résumé with nothing. */
export function payloadFrom(
  draft: ProfileDraft,
  answers: OnboardingAnswers
): Profile & GeneratedProfile {
  const hiringSignal: HiringSignal = {
    name: draft.hiringSignalName,
    sources: toList(draft.hiringSignalSources),
    qualifier: draft.hiringSignalQualifier,
    exclusions: draft.hiringSignalExclusions,
    hasRecency: draft.hiringSignalHasRecency,
    extraFields: toList(draft.hiringSignalExtraFields),
  };
  return {
    answers,
    fitBrain: draft.fitBrain,
    weakFitTail: draft.weakFitTail,
    moderateTail: draft.moderateTail,
    strongTail: draft.strongTail,
    titleScope: draft.titleScope,
    domainBonus: draft.domainBonus,
    searchSubject: draft.searchSubject,
    querySubject: draft.querySubject,
    stackFamilyIntro: draft.stackFamilyIntro,
    candidatePersona: draft.candidatePersona,
    buildingConcept: draft.buildingConcept,
    buildingUpside: draft.buildingUpside,
    hiringSignal,
    toolsAreWeak: draft.toolsAreWeak,
    titles: toList(draft.titles),
    locations: toList(draft.locations),
    stackTerms: toList(draft.stackTerms),
    locationRule: draft.locationRule,
  };
}
