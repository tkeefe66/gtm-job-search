// Pure decisions for the onboarding flow, kept OUT of app/actions/onboarding.ts
// on purpose — and this is a stronger reason than "it's the repo's usual
// answer" (see lib/fit-prompt.ts next to app/actions/parse-role.ts).
//
// app/actions/auth-required.test.ts walks every exported FUNCTION in every
// app/actions/*.ts file and asserts it rejects with "Not authenticated" when
// called with no session — that is how this codebase enforces the "requireActor
// is the first statement of every action" rule with no framework hook to hang
// it on. A pure helper exported from an action file is indistinguishable from
// an action to that sweep: it is a function, it does not call requireActor, and
// calling it with three `undefined` arguments neither throws that message nor
// rejects at all, so the file would fail a test this task must leave green.
// Living here instead of in app/actions/onboarding.ts is what keeps that sweep
// meaningful for the actions it is actually checking.
//
// A second reason, not just a workaround: none of the three needs `"use
// server"`'s async-every-export rule at all when it lives outside a "use
// server" file, so each stays an ordinary synchronous function — which is also
// what lets app/actions/onboarding.test.ts's mirror of these tests call them
// with no `await`.

import type { OnboardingAnswers } from "@/lib/profile";
import { CACHES_TO_CLEAR } from "@/lib/settings-effects";
import { SETTING_KEYS } from "@/lib/settings-store";

/**
 * Whether the answers are enough to generate from.
 *
 * `dealbreakers` is NOT required: "nothing rules a job out" is a real answer,
 * and forcing a sentence there produces a made-up constraint that then scores
 * every role for the life of the profile.
 */
export function answersAreComplete(answers: OnboardingAnswers): boolean {
  const has = (s: string) => s.trim().length > 0;
  if (!has(answers.wanted) || !has(answers.where)) return false;
  return answers.mode === "resume" ? has(answers.resume) : has(answers.current);
}

/**
 * The cache tables a completed onboarding must clear, DERIVED from
 * lib/settings-effects.ts rather than listed here.
 *
 * Onboarding writes titles, locations, stackTerms, locationRule and fitBrain in
 * one transaction, so it invalidates the union of what saving each of them
 * would invalidate. Hand-listing the union is how it drifts from the map that
 * decides — and the consequence of drift is a role_searches cache full of the
 * PREVIOUS career, served to a user who just told the app they do something
 * else.
 */
export function cachesOnboardingClears(): string[] {
  const keys = [
    SETTING_KEYS.titles,
    SETTING_KEYS.locations,
    SETTING_KEYS.stackTerms,
    SETTING_KEYS.locationRule,
    SETTING_KEYS.fitBrain,
  ];
  return Array.from(new Set(keys.flatMap((k) => CACHES_TO_CLEAR[k])));
}

/**
 * What to say when generation fails.
 *
 * Deliberately NOT describeWriteFailure / UNDESCRIBED_DB_ERROR: the failure
 * here is the model or the JSON parse, and a sentence naming the database
 * would be false. Same ruling scoreFit's catch already follows (see
 * app/actions/parse-role.ts). Non-empty always, so the caller's presence check
 * still separates failure from success.
 */
export function generationFailure(): string {
  return (
    "Could not build your profile from those answers. Try rephrasing what you " +
    "do and what you want next, then generate again."
  );
}
