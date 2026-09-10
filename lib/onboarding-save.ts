import { requireActor } from "@/lib/require-actor";
import { resolveTenantId } from "@/lib/tenant";
import { type GeneratedProfile } from "@/lib/onboarding-prompt";
import { resolveProfile, type Profile } from "@/lib/profile";
import { validateList } from "@/lib/criteria-validation";
import { cachesOnboardingClears } from "@/lib/onboarding-caches";
import { CRITERIA_CHANGED_AT_KEY, ONBOARDED_AT_KEY, PROFILE_KEY, SETTING_KEYS, describeWriteFailure } from "@/lib/settings-store";
import { rawQuery, tenantTransaction } from "@/lib/supabase";

export async function saveOnboardingProfile(
  profile: Profile & GeneratedProfile,
  preferences: { compFloor?: number | null } = {},
  withinTransaction?: (q: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) => Promise<void>
): Promise<{ error?: string }> {
  await requireActor();

  const { compFloor } = preferences;
  if (compFloor !== undefined && compFloor !== null && (!Number.isSafeInteger(compFloor) || compFloor < 1)) {
    return { error: "The minimum base must be a whole number of at least 1, or left blank." };
  }

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
      if (withinTransaction) await withinTransaction(q);
      const put = (key: string, value: unknown) =>
        q(
          `insert into app_settings (tenant_id, key, value, updated_at)
           values ($1, $2, $3::jsonb, now())
           on conflict (tenant_id, key) do update set value = excluded.value, updated_at = now()`,
          [tenantId, key, JSON.stringify(value)]
        );
      await put(PROFILE_KEY, clean);
      if (compFloor !== undefined) await put(SETTING_KEYS.compFloor, compFloor);
      await put(SETTING_KEYS.titles, titlesCheck.value);
      await put(SETTING_KEYS.locations, locationsCheck.value);
      await put(SETTING_KEYS.stackTerms, stackTermsCheck.value);
      await put(SETTING_KEYS.locationRule, locationRule);
      // The fit brain is written to BOTH the profile and its own setting row:
      // /settings edits the row, and scoringInputsFrom (lib/search-criteria.ts)
      // resolves `criteria.fitBrain || profile.fitBrain` — the ROW wins, the
      // profile is only the fallback. Writing only the profile here would leave
      // the row empty: emptySearchReason (lib/search-criteria.ts) tests
      // `criteria.fitBrain.trim()`, so role search would refuse with "your fit
      // brain is empty" even though the profile has one, and /settings reads
      // the row for its fit-brain editor, so the user would see an empty box
      // and could overwrite their own brain by saving it. Writing only the
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

