"use server";

// The onboarding flow: read what a tenant has typed so far, save it as they go,
// spend a metered Claude call turning it into a career profile, and land the
// result as one atomic write. The pure decisions this file leans on
// (answersAreComplete, generationFailure) live in lib/onboarding-rules.ts
// rather than here — see that file's header for why: app/actions/auth-
// required.test.ts walks every exported function in this directory and
// requires it to reject an unauthenticated call, and a pure helper exported
// from a "use server" file looks exactly like an action to that sweep without
// calling requireActor. cachesOnboardingClears lives one file over, in
// lib/onboarding-caches.ts, for the same reason plus one more: it reaches
// `pg` (via lib/settings-store.ts), and components/Onboarding.tsx imports
// lib/onboarding-rules.ts at runtime — splitting them is what keeps that
// import safe for the browser bundle.
//
// NOTHING HERE MAY BE LOGGED: not the prompt, not the answers, not the résumé.
// The answers carry a résumé — the most sensitive thing this app stores. Every
// other search path in this repo logs its prompt or its query list; this one
// is the documented exception. Only the FACT of a generation and its outcome
// are logged.

import { saveOnboardingProfile } from "@/lib/onboarding-save";
import { requireActor } from "@/lib/require-actor";
import { withBudget } from "@/lib/metered";

import { callStructured, parseJson } from "@/lib/model-call";
import {
  ONBOARDING_SYSTEM,
  buildOnboardingPrompt,
  truncateResume,
  type GeneratedProfile,
} from "@/lib/onboarding-prompt";
import {
  DEFAULT_PROFILE,
  resolveProfile,
  type OnboardingAnswers,
  type Profile,
} from "@/lib/profile";
import { answersAreComplete, generationFailure } from "@/lib/onboarding-rules";
import {
  UNDESCRIBED_DB_ERROR,
  describeWriteFailure,
  onboardedAtFrom,
  compFloorFrom,
  profileFrom,
  readAllSettingsResult,
  writeProfile,
} from "@/lib/settings-store";

export async function getOnboardingState(): Promise<{
  answers: OnboardingAnswers;
  onboardedAt: string | null;
  compFloor: number | null;
  isAdmin: boolean;
  error?: string;
}> {
  const actor = await requireActor();
  const { rows, error } = await readAllSettingsResult();
  // Presence, not truthiness. This page decides whether to show a user their
  // own half-finished answers; rendering empty ones because the read failed
  // would silently discard input they already gave.
  if (error !== undefined) {
    return {
      answers: DEFAULT_PROFILE.answers,
      onboardedAt: null,
      compFloor: null,
      isAdmin: actor.isAdmin,
      error: describeWriteFailure(error, "read your onboarding answers")!,
    };
  }
  return {
    answers: profileFrom(rows).answers,
    onboardedAt: onboardedAtFrom(rows),
    compFloor: compFloorFrom(rows),
    isAdmin: actor.isAdmin,
  };
}

/**
 * Stores the raw answers, BEFORE the billed call.
 *
 * They cost nothing to store and they are the whole input to a call the user
 * pays for; losing them to a refresh or a timeout means paying twice to answer
 * the same questions. Written into the profile document's `answers` field, so
 * there is still exactly one profile row.
 */
export async function saveAnswers(answers: OnboardingAnswers): Promise<{ error?: string }> {
  await requireActor();
  const { rows, error: readError } = await readAllSettingsResult();
  const described = describeWriteFailure(readError, "read your profile");
  if (described !== undefined) {
    console.error(`onboarding: ${described}`);
    return { error: described };
  }
  const next: Profile = { ...profileFrom(rows), answers: resolveProfile({ answers }).answers };
  const { error } = await writeProfile(next);
  const wrote = describeWriteFailure(error, "save your answers");
  if (wrote !== undefined) {
    console.error(`onboarding: ${wrote}`);
    return { error: wrote };
  }
  return {};
}

/**
 * Metered. It calls Claude, so it is wrapped — an unwrapped call bills the
 * platform key uncapped and unrecorded, the defect app/actions/parse-role.ts
 * documents having already shipped once.
 *
 * `capped` is returned on its OWN key rather than folded into `error`. A cap
 * here is nearly always "this tenant has no API key yet" (lib/metered.ts
 * refuses before fn runs when tier is "none", which is every brand-new
 * tenant) — a REQUIREMENT the UI renders with the key field attached, not a
 * failure.
 */
export async function generateProfile(
  answers: OnboardingAnswers
): Promise<{ profile?: GeneratedProfile; capped?: string; error?: string }> {
  const actor = await requireActor();
  // Refused before a budget is even reserved: incomplete answers are not a
  // billing decision, and reserving against the daily/monthly ceiling for a
  // call that would fail on its own input wastes both.
  if (!answersAreComplete(answers)) {
    return { error: "Answer what you want next and where you'll work before generating." };
  }
  const budget = await withBudget({
    action: "onboarding",
    estimateCents: 5,
    isAdmin: actor.isAdmin,
    fn: () => generateProfileInner(answers),
  });
  if (budget.capped) return { capped: budget.capped };
  // Presence, not truthiness — AND described. lib/metered.ts propagates a raw
  // pg message, which is "" when the database is unreachable, and onboarding
  // is the very first flow a brand-new tenant meets. An unwrapped
  // `budget.error` would render a blank failure banner on that first screen —
  // this repo's signature defect. Same fix app/actions/watchlist.ts already
  // applies at its own budget.error checks.
  if (budget.error !== undefined) {
    return {
      error: describeWriteFailure(budget.error, "generate your profile") ?? UNDESCRIBED_DB_ERROR,
    };
  }
  return budget.result!;
}

async function generateProfileInner(
  answers: OnboardingAnswers
): Promise<{ profile?: GeneratedProfile; error?: string }> {
  try {
    const { text, truncated } = truncateResume(answers.resume);
    if (truncated) {
      console.log("onboarding: résumé truncated to the length cap before generating");
    }
    const raw = await callStructured({
      system: ONBOARDING_SYSTEM,
      // NOT LOGGED, here or anywhere. The prompt carries the user's résumé —
      // the most sensitive thing this app stores. Every other search path in
      // this repo logs its prompt or its query list; this one is the
      // documented exception.
      prompt: buildOnboardingPrompt({ ...answers, resume: text }),
      // Generous: the fit brain alone is 1,500-2,500 characters and there are
      // eighteen fields. 2000 tokens has truncated a response before the JSON
      // was emitted elsewhere in this app.
      maxTokens: 6000,
    });
    const parsed = parseJson<Record<string, unknown>>(raw);
    // Validated and repaired, NEVER trusted raw. A model that returns prose
    // where a list was asked for must not produce a fit brain that is the word
    // "undefined" — resolveProfile is where that rule lives.
    const repaired = resolveProfile(parsed);
    // repaired carries an `answers` field (resolveProfile always returns a full
    // Profile) that GeneratedProfile does not have — dropped explicitly rather
    // than left to spread, so the returned shape matches the type rather than
    // merely satisfying it structurally.
    const { answers: _unusedAnswers, ...career } = repaired;
    console.log("onboarding: profile generated");
    return {
      profile: {
        ...career,
        titles: listOr(parsed.titles, []),
        locations: listOr(parsed.locations, []),
        stackTerms: listOr(parsed.stackTerms, []),
        locationRule: typeof parsed.locationRule === "string" ? parsed.locationRule : "",
      },
    };
  } catch (err) {
    // Only the error's NAME is logged, never the error itself. `err` can be a
    // SyntaxError from parseJson(raw) above, and JSON.parse's own error
    // message can embed surrounding characters of the text it failed to
    // parse — which here is the model's response to a prompt built from this
    // tenant's résumé. This file's header forbids logging the résumé; logging
    // `err` verbatim would violate that through exactly this path.
    console.error(
      `onboarding: generation failed — ${err instanceof Error ? err.name : "unknown"}`
    );
    return { error: generationFailure() };
  }
}

function listOr(v: unknown, fallback: string[]): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : fallback;
}

/**
 * The finish step: every key at once, or none.
 *
 * ONE tenantTransaction, because a partial profile is worse than no profile —
 * a tenant with titles but no fit brain passes the onboarded_at gate and then
 * scores every role against nothing. The block is short and contains no Claude
 * call, per tenantTransaction's own documented rule.
 *
 * The side effects run AFTER the commit, deliberately: clearing a cache inside
 * the transaction would roll back on a failure that has already been reported,
 * and a revalidatePath inside a database transaction is meaningless.
 *
 * A RE-RUN takes the same path. Writing the rows without these effects leaves
 * role_searches and discovered_roles full of the previous career, skips the
 * criteria_changed_at stamp the crawler's closure debounce reads, and skips
 * the rescore offer (which reads fitBrainOverridden off the SETTING_KEYS.fitBrain
 * row this writes, in lib/rescore-progress.ts) — producing a jobs table scored
 * half against one career and half against another with nothing on screen
 * distinguishing them.
 */
export async function saveProfile(
  profile: Profile & GeneratedProfile,
  preferences: { compFloor?: number | null } = {}
): Promise<{ error?: string }> {
  await requireActor();
  return saveOnboardingProfile(profile, preferences);
}

/** Forgets the stored answers, résumé included, leaving the profile itself. */
export async function clearAnswers(): Promise<{ error?: string }> {
  await requireActor();
  const { rows, error } = await readAllSettingsResult();
  const described = describeWriteFailure(error, "read your profile");
  if (described !== undefined) return { error: described };
  const { error: writeError } = await writeProfile({
    ...profileFrom(rows),
    answers: DEFAULT_PROFILE.answers,
  });
  const wrote = describeWriteFailure(writeError, "clear your answers");
  return wrote === undefined ? {} : { error: wrote };
}
