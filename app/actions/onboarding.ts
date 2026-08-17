"use server";

// The onboarding flow: read what a tenant has typed so far, save it as they go,
// spend a metered Claude call turning it into a career profile, and land the
// result as one atomic write. The pure decisions this file leans on
// (answersAreComplete, cachesOnboardingClears, generationFailure) live in
// lib/onboarding-rules.ts rather than here — see that file's header for why:
// app/actions/auth-required.test.ts walks every exported function in this
// directory and requires it to reject an unauthenticated call, and a pure
// helper exported from a "use server" file looks exactly like an action to
// that sweep without calling requireActor.
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
import { answersAreComplete, cachesOnboardingClears, generationFailure } from "@/lib/onboarding-rules";
import {
  CRITERIA_CHANGED_AT_KEY,
  ONBOARDED_AT_KEY,
  PROFILE_KEY,
  SETTING_KEYS,
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
  // Presence, not truthiness: an unreachable database reports an empty message.
  if (budget.error !== undefined) return { error: budget.error };
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
    // The real error is logged, and logged is the only place it goes — never
    // the prompt or the answers that produced it.
    console.error("onboarding: generation failed:", err);
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
  for (const [items, label] of [
    [profile.titles, "Target titles"],
    [profile.locations, "Location terms"],
  ] as const) {
    const check = validateList(items, label);
    if (!check.ok) return { error: check.error };
  }

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
      await put(SETTING_KEYS.titles, profile.titles);
      await put(SETTING_KEYS.locations, profile.locations);
      await put(SETTING_KEYS.stackTerms, profile.stackTerms);
      await put(SETTING_KEYS.locationRule, profile.locationRule);
      // The fit brain is written to BOTH the profile and its own setting row:
      // /settings edits the row, and scoringInputsFrom reads the profile first
      // and falls back to the row. Writing only one would make the settings
      // page show a brain the scorer does not use, or the reverse.
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
