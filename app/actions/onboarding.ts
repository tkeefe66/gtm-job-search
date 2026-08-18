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

import { requireActor } from "@/lib/require-actor";
import { withBudget } from "@/lib/metered";
import { resolveTenantId } from "@/lib/tenant";

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
import { validateList } from "@/lib/criteria-validation";
import { answersAreComplete, generationFailure } from "@/lib/onboarding-rules";
import { cachesOnboardingClears } from "@/lib/onboarding-caches";
import {
  CRITERIA_CHANGED_AT_KEY,
  ONBOARDED_AT_KEY,
  PROFILE_KEY,
  SETTING_KEYS,
  UNDESCRIBED_DB_ERROR,
  describeWriteFailure,
  onboardedAtFrom,
  profileFrom,
  readAllSettingsResult,
  writeProfile,
} from "@/lib/settings-store";
import { rawQuery, tenantTransaction } from "@/lib/supabase";

export async function getOnboardingState(): Promise<{
  answers: OnboardingAnswers;
  onboardedAt: string | null;
  error?: string;
}> {
  await requireActor();
  const { rows, error } = await readAllSettingsResult();
  // Presence, not truthiness. This page decides whether to show a user their
  // own half-finished answers; rendering empty ones because the read failed
  // would silently discard input they already gave.
  if (error !== undefined) {
    return {
      answers: DEFAULT_PROFILE.answers,
      onboardedAt: null,
      error: describeWriteFailure(error, "read your onboarding answers")!,
    };
  }
  return {
    answers: profileFrom(rows).answers,
    onboardedAt: onboardedAtFrom(rows),
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
  profile: Profile & GeneratedProfile
): Promise<{ error?: string }> {
  await requireActor();

  // Blocked at the action as well as at the screen. An empty fit brain is the
  // one field whose absence is not recoverable by editing later: every role
  // ingested in the meantime is scored against nothing.
  if (!profile.fitBrain.trim()) {
    return { error: "Your profile needs a description of you before it can be saved." };
  }

  // Every list is NORMALIZED here, not merely validated — trimmed,
  // deduplicated, quote-checked — and it is the normalized value that gets
  // written, never the raw one. This is the ONE path in the app where these
  // lists arrive from a MODEL rather than a human, so unnormalized input is
  // likeliest exactly here: `saveCriteriaList` in app/actions/settings.ts
  // writes `result.value` for the same reason, and writing `profile.titles`
  // raw would let ["CNC Programmer", "cnc programmer", " CNC  Machinist "]
  // through untouched, with titleQueries then billing a duplicate search for
  // the case-variant.
  const titlesCheck = validateList(profile.titles, "Target titles");
  if (!titlesCheck.ok) return { error: titlesCheck.error };
  const locationsCheck = validateList(profile.locations, "Location terms");
  if (!locationsCheck.ok) return { error: locationsCheck.error };
  // stackTerms is allowed to be EMPTY on this path only. lib/onboarding-prompt.ts
  // tells the model to return an empty array when toolsAreWeak is true — a
  // nurse, a paralegal, any field where a tool-name search would return mostly
  // noise — and emptySearchReason (lib/search-criteria.ts) already degrades
  // that correctly: it refuses only the "stack" search family, the "title"
  // family still runs. Without allowEmpty, that exact toolsAreWeak case failed
  // Finish with "Stack terms cannot be empty … or use Reset to defaults" — a
  // control that does not exist on /welcome. /settings' own save
  // (saveCriteriaList -> validateList with no allowEmpty) is untouched and
  // still refuses an empty list there.
  const stackTermsCheck = validateList(profile.stackTerms, "Stack terms", { allowEmpty: true });
  if (!stackTermsCheck.ok) return { error: stackTermsCheck.error };
  // locationRule is a TextSettingKey on /settings (saveCriteriaText), whose
  // own check is exactly this: trim, and refuse empty.
  const locationRule = profile.locationRule.trim();
  if (!locationRule) return { error: "Location rule cannot be empty." };

  const tenantId = await resolveTenantId();
  const clean = resolveProfile(profile);
  const now = new Date().toISOString();

  try {
    await tenantTransaction(tenantId, async (q) => {
      const put = (key: string, value: unknown) =>
        q(
          `insert into app_settings (tenant_id, key, value, updated_at)
           values ($1, $2, $3::jsonb, now())
           on conflict (tenant_id, key) do update set value = excluded.value, updated_at = now()`,
          [tenantId, key, JSON.stringify(value)]
        );
      await put(PROFILE_KEY, clean);
      await put(SETTING_KEYS.titles, titlesCheck.value);
      await put(SETTING_KEYS.locations, locationsCheck.value);
      await put(SETTING_KEYS.stackTerms, stackTermsCheck.value);
      await put(SETTING_KEYS.locationRule, locationRule);
      // The fit brain is written to BOTH the profile and its own setting row:
      // /settings edits the row, and scoringInputsFrom (lib/search-criteria.ts)
      // resolves `criteria.fitBrain || profile.fitBrain` — the ROW wins, the
      // profile is only the fallback. Writing only the profile here would leave
      // the row empty, and every scoreFit call would fall through to whatever
      // the row degrades to instead of this tenant's brain. Writing only the
      // row would leave /settings displaying a brain the profile never agreed
      // with. Both must be written for the same reason app/actions/settings.ts
      // documents on saveProfileFields: the row already wins every read, so
      // this is the one write that keeps it non-empty from the start.
      await put(SETTING_KEYS.fitBrain, clean.fitBrain);
      // CRITERIA_CHANGED_AT_KEY, never the literal "criteria_changed_at". The
      // constant exists precisely so a writer and its reader cannot drift on
      // the spelling, and a drifted key here is a silent no-op: the crawler's
      // stale-posting debounce would never see the change.
      await put(CRITERIA_CHANGED_AT_KEY, now);
      await put(ONBOARDED_AT_KEY, now);
    });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    console.error(`onboarding: could not save the profile — ${why}`);
    return { error: describeWriteFailure(why, "save your profile")! };
  }

  console.log("onboarding: profile saved");

  // After the commit. Non-fatal: the profile is already stored, and a surviving
  // cache serves stale results until it expires, which is worse than fresh but
  // far better than telling the user the save failed when it did not.
  for (const table of cachesOnboardingClears()) {
    const { error } = await rawQuery(
      `delete from ${table} where tenant_id = $1`,
      [tenantId],
      tenantId
    );
    if (error) console.error(`onboarding: could not clear ${table} — ${error.message}`);
  }
  return {};
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
