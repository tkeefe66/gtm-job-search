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
// A second reason, not just a workaround: none of these needs `"use
// server"`'s async-every-export rule at all when it lives outside a "use
// server" file, so each stays an ordinary synchronous function — which is also
// what lets app/actions/onboarding.test.ts's mirror of these tests call them
// with no `await`.
//
// NO import that transitively reaches `pg`, on top of that — components/
// Onboarding.tsx imports this module at RUNTIME, not just for types, so it has
// the same constraint lib/profile.ts documents at its own top. That is also
// why cachesOnboardingClears lives in lib/onboarding-caches.ts instead of here:
// it needs lib/settings-effects.ts -> lib/settings-store.ts -> lib/supabase.ts,
// and `pg` imports `net`/`tls`/`fs`/`dns`, none of which exist in a browser
// bundle. Putting it in THIS file broke `npm run build` outright — webpack
// cannot tree-shake an import with module-scope side effects (lib/supabase.ts
// opens a connection pool at import time) just because the client component
// happens not to call the one export that needed it.

import type { OnboardingAnswers } from "@/lib/profile";
import type { FitPromptRole } from "@/lib/fit-prompt";

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

/**
 * A canned posting for Step 4's sample score, built from the profile that was
 * just generated rather than asking the user to paste a real one.
 *
 * "Here is what we understood, edit anything that is wrong" over a block of
 * rubric prose gives the user no way to judge it — they have never seen the
 * scoring prompt, and the only real feedback loop is fit scores hours later.
 * This is what lets Step 4 score ONE role instead: a wrong fit brain becomes
 * visible right away as "it scored a shop-floor technician job a 4" rather
 * than as a silently miscalibrated pipeline.
 *
 * Deliberately GENERIC beyond the title and location: an invented company
 * description or skill list would ask the model to judge how well a company
 * that does not exist matches — which says nothing about whether the FIT
 * BRAIN and TITLE SCOPE fields are right, the two things this sample exists
 * to sanity-check. Every field the draft does not supply stays "" rather than
 * being fabricated, matching FitPromptRole's own contract that "" means the
 * posting published nothing.
 */
/**
 * Step 0's copy, under the API key panel.
 *
 * MUST be true for both a BYO tenant and an admin. The previous wording —
 * "This app runs entirely on your own model API key — nothing you do here
 * bills anyone but you, and there is no free tier to fall back on" — is false
 * for an admin: resolveTier (lib/budget.ts) gives an admin the platform key
 * regardless of whether one is stored, so an admin with no key is tier
 * "admin", never tier "none". Step 0 is a pre-flight HINT that a key is USEFUL,
 * not a promise that one is required — the authoritative refusal is `capped`
 * from generateProfile, which lib/metered.ts returns only for tier "none" (a
 * non-admin with no key), and the review step already renders that with the
 * key field attached. This copy says what is true for everyone and points at
 * that later, real check instead of asserting a requirement client-side
 * onboarding cannot verify.
 */
export function keyStepCopy(): string {
  return (
    "A key is how most accounts pay for their own model usage — you can add " +
    "yours below. If your account can't generate a profile without one, " +
    "you'll be told at the next step, with this field right there."
  );
}

export function sampleRoleFor(input: {
  titles: string[];
  locations: string[];
}): FitPromptRole {
  const title = input.titles.find((t) => t.trim().length > 0);
  const location = input.locations.find((l) => l.trim().length > 0);
  return {
    company: "A sample employer",
    role_title: title ?? "the role you're searching for",
    company_description: "",
    key_skills: "",
    fit_summary: "",
    department: "",
    location: location ?? "",
    salary_range: "",
  };
}
