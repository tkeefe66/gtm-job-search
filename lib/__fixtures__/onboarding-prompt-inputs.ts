// The inputs the checked-in onboarding-prompt fixtures were rendered from.
// Shared by lib/onboarding-prompt.test.ts and the regeneration command
// documented there, so the two cannot drift — the same arrangement
// fit-prompt-inputs.ts has.
//
// Deliberately NOT a GTM profile: these fixtures are the one place in the repo
// where a reader can see what the flow does for someone who is not the previous
// user, and a GTM example would hide exactly the failure the fixtures exist to
// expose.

import type { OnboardingAnswers } from "@/lib/profile";

export const FIXTURE_QUESTIONS: OnboardingAnswers = {
  mode: "questions",
  current:
    "Senior mechanical engineer at a medical device manufacturer, six years designing surgical instrument mechanisms in SolidWorks with FEA in ANSYS.",
  wanted:
    "Principal or staff design engineer, ideally somewhere I own a product line end to end rather than one subassembly.",
  where: "Denver or remote; I would relocate for the right role in the Front Range.",
  dealbreakers: "No defence work, and nothing requiring five days on site.",
  resume: "",
};

export const FIXTURE_RESUME: OnboardingAnswers = {
  mode: "resume",
  current: "",
  wanted:
    "A charge nurse or nurse manager role — I want to run a unit rather than take a full patient load.",
  where: "Colorado Springs, in person.",
  dealbreakers: "No night shifts.",
  resume:
    "REGISTERED NURSE — 9 years, med-surg and step-down. BSN, University of Colorado. ACLS, PALS. Charge nurse on rotation since 2023; precepted 11 new graduates.",
};
