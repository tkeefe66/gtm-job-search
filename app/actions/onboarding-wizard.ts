"use server";

import { randomUUID } from "node:crypto";
import { requireActor } from "@/lib/require-actor";
import { rawQuery, tenantTransaction } from "@/lib/supabase";
import { withBudget } from "@/lib/metered";
import { callStructured, parseJson } from "@/lib/model-call";
import { ONBOARDING_SYSTEM, buildOnboardingPrompt, type GeneratedProfile } from "@/lib/onboarding-prompt";
import { resolveProfile } from "@/lib/profile";
import { SETTING_KEYS, PROFILE_KEY, onboardedAtFrom, compFloorFrom } from "@/lib/settings-store";
import { describeWriteFailure } from "@/lib/write-failure";
import { saveOnboardingProfile } from "@/lib/onboarding-save";
import { findExistingCompany } from "@/lib/find-existing-company";
import { applyWizardPreferences, emptyWizardAnswers, resolveWizardAnswers, wizardCompleteError, wizardFingerprint, wizardInputError, wizardPromptAnswers, WIZARD_DRAFT_KEY, type WizardAnswers, type WizardDraft } from "@/lib/onboarding-wizard";

type Query = (text: string, values?: unknown[]) => Promise<{rows: Record<string, unknown>[]} >;
type StoredDraft = WizardDraft & { fingerprint?: string; generationId?: string };
const putDraft = (q: Query, tenantId: string, draft: StoredDraft) => q(
  `insert into app_settings (tenant_id,key,value,updated_at) values ($1,$2,$3::jsonb,now())
   on conflict (tenant_id,key) do update set value=excluded.value,updated_at=now()`,
  [tenantId, WIZARD_DRAFT_KEY, JSON.stringify(draft)]);
async function lockedDraft(q: Query, tenantId: string): Promise<StoredDraft | undefined> {
  // Includes the absent-row case; generation never holds this lock across its paid call.
  await q("select pg_advisory_xact_lock(hashtext($1))", [`onboarding-wizard:${tenantId}`]);
  const {rows} = await q("select value from app_settings where tenant_id=$1 and key=$2 for update", [tenantId, WIZARD_DRAFT_KEY]);
  return rows[0]?.value as StoredDraft | undefined;
}
function dbFailure(error: unknown, operation: string) {
  return {error: describeWriteFailure(error instanceof Error ? error.message : "", operation)!};
}
function input(raw: WizardAnswers, complete = false): {answers: WizardAnswers; error?: string} {
  const answers = resolveWizardAnswers(raw);
  const error = wizardInputError(raw) ?? (complete ? wizardCompleteError(answers) : undefined);
  return {answers, error};
}
function cleanDraft(stored: StoredDraft): WizardDraft {
  const answers = resolveWizardAnswers(stored.answers);
  return {answers, step: Number.isInteger(stored.step) ? Math.max(0, Math.min(10, stored.step)) : 0,
    ...(stored.generated && stored.fingerprint === wizardFingerprint(answers) ? {generated: stored.generated} : {})};
}
export async function getWizardState(): Promise<{draft: WizardDraft; onboardedAt: string|null; isAdmin: boolean; error?: string}> {
  const actor = await requireActor();
  const {data, error} = await rawQuery<{key: string; value: unknown}>("select key,value from app_settings where tenant_id=$1", [actor.tenantId], actor.tenantId);
  if (error) return {draft: {answers: emptyWizardAnswers(), step: 0}, onboardedAt: null, isAdmin: actor.isAdmin, ...dbFailure(error, "read your saved setup")};
  const rows = data ?? [];
  const stored = rows.find(r => r.key === WIZARD_DRAFT_KEY)?.value as StoredDraft | undefined;
  const profile = rows.find(r => r.key === PROFILE_KEY)?.value as {answers?: unknown} | undefined;
  const legacy = resolveWizardAnswers(profile?.answers);
  const savedList = (key: string) => rows.find(r => r.key === key)?.value;
  const floor = compFloorFrom(rows);
  const answers = resolveWizardAnswers({...legacy, titles: savedList(SETTING_KEYS.titles), tools: savedList(SETTING_KEYS.stackTerms), compFloor: floor === null ? "" : String(floor)});
  return {draft: stored ? cleanDraft(stored) : {answers, step: 0}, onboardedAt: onboardedAtFrom(rows), isAdmin: actor.isAdmin};
}
export async function saveWizardProgress(raw: WizardAnswers, step: number): Promise<{error?: string}> {
  const actor = await requireActor();
  const {answers, error} = input(raw);
  if (error !== undefined) return {error};
  if (!Number.isInteger(step) || step < 0 || step > 10) return {error: "Choose a valid setup step."};
  try {
    await tenantTransaction(actor.tenantId, async q => {
      const previous = await lockedDraft(q, actor.tenantId);
      const unchanged = previous && wizardFingerprint(previous.answers) === wizardFingerprint(answers);
      await putDraft(q, actor.tenantId, {...(unchanged ? previous : {}), answers, step});
    });
    return {};
  } catch (error) { return dbFailure(error, "save your setup progress"); }
}
export async function generateWizardProfile(raw: WizardAnswers): Promise<{profile?: GeneratedProfile; capped?: string; error?: string}> {
  const actor = await requireActor();
  const {answers, error} = input(raw, true);
  if (error !== undefined) return {error};
  const fingerprint = wizardFingerprint(answers);
  const generationId = randomUUID();
  try {
    await tenantTransaction(actor.tenantId, async q => {
      const previous = await lockedDraft(q, actor.tenantId);
      const reusable = previous?.generated && previous.fingerprint === fingerprint;
      // A failed explicit retry must not destroy a result already paid for.
      await putDraft(q, actor.tenantId, {...(reusable ? previous : {}), answers, step: reusable ? 10 : 9, generationId});
    });
  } catch (error) { return dbFailure(error, "save your answers before generating"); }
  const budget = await withBudget({action: "onboarding", estimateCents: 5, isAdmin: actor.isAdmin, fn: async () => {
    try {
      const response = await callStructured({system: ONBOARDING_SYSTEM + " Only the current-background answer or résumé provides evidence of existing experience. Desired roles, tools, industries and priorities describe future preferences; never convert them into credentials, proficiency or past accomplishments. Do not claim experience unless the background explicitly supports it.", prompt: buildOnboardingPrompt(wizardPromptAnswers(answers)), maxTokens: 6000});
      const parsed = parseJson<Record<string, unknown>>(response);
      // Do not silently repair missing career fields with another user's defaults.
      for (const key of ["fitBrain", "weakFitTail", "moderateTail", "strongTail", "searchSubject", "querySubject", "stackFamilyIntro", "candidatePersona", "buildingConcept", "buildingUpside", "locationRule"])
        if (typeof parsed[key] !== "string" || !(parsed[key] as string).trim()) throw new Error("Incomplete profile");
      for (const key of ["titleScope", "domainBonus"])
        if (typeof parsed[key] !== "string") throw new Error("Incomplete optional profile field");
      for (const key of ["titles", "locations"])
        if (!Array.isArray(parsed[key]) || !(parsed[key] as unknown[]).length || (parsed[key] as unknown[]).some(v => typeof v !== "string" || !v.trim() || v.includes('"'))) throw new Error("Incomplete search terms");
      const {answers: _answers, ...career} = resolveProfile(parsed);
      const profile = applyWizardPreferences({...career, titles: parsed.titles as string[], locations: parsed.locations as string[], stackTerms: [], locationRule: parsed.locationRule as string}, answers);
      console.log("onboarding wizard: profile generated");
      return {profile};
    } catch { console.error("onboarding wizard: generation failed"); return {error: "Profile generation failed. Check your API key and try again; your answers are saved."}; }
  }});
  if (budget.capped !== undefined) return {capped: budget.capped};
  if (budget.error !== undefined) return {error: describeWriteFailure(budget.error, "generate your profile")!};
  if (!budget.result || budget.result.error !== undefined) return {error: budget.result?.error ?? "Profile generation returned no result. Try again."};
  const profile = budget.result.profile!;
  try {
    return await tenantTransaction(actor.tenantId, async q => {
      const previous = await lockedDraft(q, actor.tenantId);
      if (!previous || previous.generationId !== generationId || wizardFingerprint(previous.answers) !== fingerprint)
        return {error: "Your answers changed while generating. Generate again from your latest answers."};
      await putDraft(q, actor.tenantId, {answers, step: 10, generated: profile, fingerprint});
      return {profile};
    });
  } catch (error) { return dbFailure(error, "save your generated profile"); }
}
export async function finishWizardOnboarding(raw: WizardAnswers): Promise<{error?: string}> {
  const actor = await requireActor();
  const {answers, error} = input(raw, true);
  if (error !== undefined) return {error};
  const fingerprint = wizardFingerprint(answers);
  const {data, error: readError} = await rawQuery<{value: StoredDraft}>("select value from app_settings where tenant_id=$1 and key=$2", [actor.tenantId, WIZARD_DRAFT_KEY], actor.tenantId);
  if (readError) return dbFailure(readError, "read your generated profile");
  const draft = data?.[0]?.value;
  if (!draft?.generated || draft.fingerprint !== fingerprint) return {error: "Your answers changed. Generate a fresh profile before finishing."};
  const generated = JSON.stringify(draft.generated);
  return saveOnboardingProfile({...draft.generated, answers: wizardPromptAnswers(answers)}, {compFloor: answers.compFloor ? Number(answers.compFloor) : null}, async q => {
    const current = await lockedDraft(q, actor.tenantId);
    if (!current?.generated || current.fingerprint !== fingerprint || JSON.stringify(current.generated) !== generated) throw new Error("Your setup changed. Generate a fresh profile before finishing.");
    // Unlike a title edit, this changes the discovery signal itself. Old employer
    // results must not survive an industry, funding-stage, or exclusion change.
    await q("delete from discovered_startups where tenant_id=$1", [actor.tenantId]);
    const result = await q("select company,careers_url from watchlist where tenant_id=$1 for update", [actor.tenantId]);
    const companies = result.rows as {company: string; careers_url: string|null}[];
    for (const company of answers.companies) {
      const existing = findExistingCompany(companies, company.name);
      const name = existing?.company ?? company.name;
      // The stored spelling and URL win; a setup preference must not rename an employer.
      await q(`insert into watchlist (tenant_id,company,careers_url,source,tracking_enabled)
        values ($1,$2,$3,'manual',true) on conflict (tenant_id,company) do update
        set careers_url=coalesce(nullif(watchlist.careers_url,''),excluded.careers_url),tracking_enabled=true`,
        [actor.tenantId, name, existing?.careers_url || company.careersUrl || null]);
      if (!existing) companies.push({company: name, careers_url: company.careersUrl});
    }
    // Keep the structured preferences for a later rerun; Profile.answers is the legacy prose form.
    await putDraft(q, actor.tenantId, {...current, answers, step: 10});
  });
}
export async function clearWizardProgress(): Promise<{error?: string}> {
  const actor = await requireActor();
  try {
    await tenantTransaction(actor.tenantId, async q => {
      await lockedDraft(q, actor.tenantId);
      // Persist an empty draft so legacy active-profile answers do not reappear on refresh.
      await putDraft(q, actor.tenantId, {answers: emptyWizardAnswers(), step: 0});
    });
    return {};
  } catch (error) { return dbFailure(error, "clear your setup answers"); }
}
