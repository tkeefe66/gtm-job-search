// The inputs the checked-in fit-prompt fixtures were rendered from.
//
// Shared by lib/fit-prompt.test.ts and by the regeneration command documented
// there, so the two cannot drift: a fixture rendered from one set of inputs and
// compared against another would fail for a reason that has nothing to do with
// the prompt.
//
// Every value is distinct and non-empty on purpose. Two fields carrying the
// same text would let a transposition (`Company: ${role.role_title}`) render a
// byte-identical prompt.

import type { FitInputs } from "@/lib/fit-inputs";
import type { FitPromptRole } from "@/lib/fit-prompt";
import {
  DEFAULT_WEAK_FIT_TAIL,
  DEFAULT_MODERATE_TAIL,
  DEFAULT_STRONG_TAIL,
  DEFAULT_TITLE_SCOPE,
  DEFAULT_DOMAIN_BONUS,
} from "@/lib/fit-prompt";

export const FIXTURE_BRAIN = "A candidate who does GTM systems.";

export const FIXTURE_ROLE: FitPromptRole = {
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

export const FIXTURE_NO_FLOOR: FitInputs = {
  fitBrain: FIXTURE_BRAIN,
  compFloor: null,
  weakFitTail: DEFAULT_WEAK_FIT_TAIL,
  moderateTail: DEFAULT_MODERATE_TAIL,
  strongTail: DEFAULT_STRONG_TAIL,
  titleScope: DEFAULT_TITLE_SCOPE,
  domainBonus: DEFAULT_DOMAIN_BONUS,
};

// 180000, not 180 or 1800: the rendered figure has to cross a thousands
// separator, which is what makes the fixture pin the number formatting too.
export const FIXTURE_WITH_FLOOR: FitInputs = {
  fitBrain: FIXTURE_BRAIN,
  compFloor: 180000,
  weakFitTail: DEFAULT_WEAK_FIT_TAIL,
  moderateTail: DEFAULT_MODERATE_TAIL,
  strongTail: DEFAULT_STRONG_TAIL,
  titleScope: DEFAULT_TITLE_SCOPE,
  domainBonus: DEFAULT_DOMAIN_BONUS,
};

// Task 2: titleScope/domainBonus stripped, everything else matching
// FIXTURE_WITH_FLOOR — proves both blocks vanish cleanly (no bare heading, no
// dangling carve-out) when a tenant supplies no text for them.
export const FIXTURE_EMPTY_BLOCKS: FitInputs = {
  fitBrain: FIXTURE_BRAIN,
  compFloor: 180000,
  weakFitTail: DEFAULT_WEAK_FIT_TAIL,
  moderateTail: DEFAULT_MODERATE_TAIL,
  strongTail: DEFAULT_STRONG_TAIL,
  titleScope: "",
  domainBonus: "",
};
