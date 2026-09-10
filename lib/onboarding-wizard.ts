import { RESUME_MAX_CHARS, type GeneratedProfile } from "@/lib/onboarding-prompt";
import type { OnboardingAnswers } from "@/lib/profile";
import { readCompanyInput } from "@/lib/company-input";

export interface WizardAnswers {
  mode: "questions" | "resume";
  current: string; resume: string; wanted: string;
  titles: string[]; tools: string[]; location: string; workModes: string[];
  locationImportance: "preference" | "required";
  priorities: string[]; compFloor: string; travel: string; exclusions: string;
  industries: string[]; companies: {name: string; careersUrl: string}[];
  signals: ("hiring" | "funding")[]; fundingStages: string[];
}
export interface WizardDraft { answers: WizardAnswers; step: number; generated?: GeneratedProfile }
export const WIZARD_DRAFT_KEY = "onboarding_wizard_draft";
export function emptyWizardAnswers(): WizardAnswers {
  return {mode: "questions", current: "", resume: "", wanted: "", titles: [], tools: [], location: "", workModes: [], locationImportance: "preference", priorities: [], compFloor: "", travel: "No preference", exclusions: "", industries: [], companies: [], signals: ["hiring"], fundingStages: []};
}
const strings = (v: unknown): string[] => Array.isArray(v) ? Array.from(new Set(v.filter((s): s is string => typeof s === "string").map(s => s.trim()).filter(Boolean))) : [];
const string = (v: unknown) => typeof v === "string" ? v.trim() : "";
/** Tolerant reader for stored/legacy data. Writes additionally require strict validation. */
export function resolveWizardAnswers(raw: unknown): WizardAnswers {
  const a = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    mode: a.mode === "resume" ? "resume" : "questions", current: string(a.current), resume: string(a.resume).slice(0, RESUME_MAX_CHARS), wanted: string(a.wanted),
    titles: strings(a.titles), tools: strings(a.tools), location: string(a.location ?? a.where), workModes: strings(a.workModes),
    locationImportance: a.locationImportance === "required" ? "required" : "preference", priorities: strings(a.priorities), compFloor: string(a.compFloor), travel: string(a.travel) || "No preference", exclusions: string(a.exclusions ?? a.dealbreakers), industries: strings(a.industries),
    companies: Array.isArray(a.companies) ? a.companies.map(c => ({name: string(c?.name), careersUrl: string(c?.careersUrl)})) : [],
    signals: a.signals === undefined ? ["hiring"] : strings(a.signals).filter((s): s is "hiring" | "funding" => s === "hiring" || s === "funding"), fundingStages: strings(a.fundingStages),
  };
}
export function wizardInputError(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "Your answers could not be read. Refresh and try again.";
  const a = raw as Record<string, unknown>;
  if (a.mode !== "questions" && a.mode !== "resume") return "Choose how to describe your background.";
  if (a.locationImportance !== "preference" && a.locationImportance !== "required") return "Choose whether location is a preference or requirement.";
  for (const key of ["current", "resume", "wanted", "location", "compFloor", "travel", "exclusions"]) {
    if (typeof a[key] !== "string") return "Your answers contain an invalid text field. Refresh and try again.";
    if ((a[key] as string).length > (key === "resume" ? RESUME_MAX_CHARS : 4000)) return `${key === "resume" ? "Résumé" : "Answer"} is too long. Shorten it and try again.`;
  }
  for (const key of ["titles", "tools", "workModes", "priorities", "industries", "signals", "fundingStages"]) {
    const list = a[key];
    if (!Array.isArray(list) || list.length > 40 || list.some(s => typeof s !== "string" || !s.trim() || s.length > 160)) return "Choose up to 40 short entries per question.";
  }
  if ((a.signals as string[]).some(s => s !== "hiring" && s !== "funding")) return "Choose hiring or funding signals.";
  if ((a.workModes as string[]).some(s => !["Remote", "Hybrid", "On-site"].includes(s))) return "Choose a listed work arrangement.";
  if ((a.priorities as string[]).some(s => !["Compensation", "Leading a team", "Hands-on work", "Flexibility", "Career growth", "Stability"].includes(s))) return "Choose a listed priority.";
  if ((a.fundingStages as string[]).some(s => !["Seed / early stage", "Series A", "Series B or later"].includes(s))) return "Choose a listed funding stage.";
  if (a.travel !== "" && !["No preference", "No travel", "Occasional travel only", "Up to 25% travel"].includes(a.travel as string)) return "Choose a listed travel preference.";
  if ([...(a.titles as string[]), ...(a.tools as string[])].some(s => s.includes('"'))) return "Remove quotation marks from target titles and tools.";
  if (!Array.isArray(a.companies) || a.companies.length > 30 || a.companies.some(c => !c || typeof c.name !== "string" || typeof c.careersUrl !== "string" || c.name.length > 160 || c.careersUrl.length > 2048)) return "Add up to 30 companies with a name and careers URL.";
  const floor = string(a.compFloor);
  if (floor && (!/^\d+$/.test(floor) || !Number.isSafeInteger(Number(floor)) || Number(floor) < 1)) return "Minimum base must be a positive whole number, or left blank.";
}
export function wizardStepError(answers: WizardAnswers, step: number): string | undefined {
  if (step === 0 && !(answers.mode === "resume" ? answers.resume : answers.current).trim()) return answers.mode === "resume" ? "Upload or paste your résumé to continue." : "Tell us what you do now to continue.";
  if (step === 1 && !answers.wanted.trim() && !answers.titles.length) return "Describe your next role or add a target title.";
  if (step === 3 && !answers.location.trim() && !answers.workModes.includes("Remote")) return "Add a location or choose remote work.";
  if (step === 5 && answers.compFloor.trim() && (!/^\d+$/.test(answers.compFloor.trim()) || !Number.isSafeInteger(Number(answers.compFloor)) || Number(answers.compFloor) < 1)) return "Minimum base must be a positive whole number, or left blank.";
  if (step === 7) for (const company of answers.companies) {
    if (!company.name.trim() || readCompanyInput(company.name).kind !== "name" || /:\/\//.test(company.name)) return "Confirm a company name, separate from its careers URL.";
    if (!company.careersUrl.trim()) continue;
    try {
      const url = new URL(company.careersUrl);
      if (!["http:", "https:"].includes(url.protocol) || !url.hostname.includes(".") || url.username || url.password) throw new Error();
    } catch { return "Each confirmed company needs a valid http or https careers URL."; }
  }
}
export function wizardCompleteError(a: WizardAnswers): string | undefined {
  for (let step = 0; step <= 8; step++) { const error = wizardStepError(a, step); if (error !== undefined) return error; }
}
export function wizardFingerprint(a: WizardAnswers): string { return JSON.stringify(resolveWizardAnswers(a)); }
export function wizardPromptAnswers(a: WizardAnswers): OnboardingAnswers {
  return {mode: a.mode, current: a.current, resume: a.resume,
    wanted: [a.wanted, `Target titles: ${a.titles.join(", ") || "derive from the background and desired work"}.`, `Desired tools for FUTURE work, not evidence of experience: ${a.tools.join(", ") || "none specified"}. Never claim proficiency or past use from this list.`, `Priorities: ${a.priorities.join(", ") || "none specified"}.`, `Preferred industries: ${a.industries.join(", ") || "no industry restriction"}.`, `Companies of interest: ${a.companies.map(c => c.name).join(", ") || "none specified"}.`, `Company discovery: ${a.signals.join(" or ")}. Funding stages: ${a.fundingStages.join(", ") || "not applicable"}. Funding stages constrain funding matches only, never hiring matches. Funding alone is not proof of hiring.`].join("\n"),
    where: `${a.location || "Any location"}; ${a.workModes.join(", ")}. Location is a ${a.locationImportance}.`,
    dealbreakers: [a.exclusions, a.travel && `Travel: ${a.travel}.`, a.compFloor && `Minimum base compensation: $${a.compFloor}.`].filter(Boolean).join("\n")};
}
/** Persist the user's explicit constraints deterministically, independent of model compliance. */
export function applyWizardPreferences(profile: GeneratedProfile, a: WizardAnswers): GeneratedProfile {
  const funding = a.signals.includes("funding");
  const hiring = a.signals.includes("hiring");
  return {...profile, titles: a.titles.length ? [...a.titles] : profile.titles,
    stackTerms: [...a.tools], toolsAreWeak: a.tools.length === 0,
    hiringSignal: {
      name: hiring && funding ? "verified hiring activity or funding rounds" : funding ? "funding rounds" : hiring ? "verified hiring activity" : "relevant employers in the candidate's field",
      sources: hiring && funding ? ["Company careers pages", "Company announcements", "Funding announcements", "Industry publications"] : funding ? ["Company funding announcements", "Industry publications"] : hiring ? ["Company careers pages", "Company hiring announcements"] : ["Company websites", "Industry publications", "Employer directories"],
      qualifier: [a.industries.length ? `Industries: ${a.industries.join(", ")}.` : "", funding ? `For funding matches only, include ${a.fundingStages.length ? a.fundingStages.join(", ") : "any funding stage"}. Funding is not proof of hiring.` : hiring ? "Require evidence of hiring; funding alone does not qualify." : "Include relevant employers without requiring hiring or funding announcements.", hiring ? "Hiring matches require current openings or explicit hiring announcements." : ""].filter(Boolean).join(" "),
      exclusions: [a.exclusions, funding && a.fundingStages.length ? `For funding matches only, exclude all funding stages other than ${a.fundingStages.join(", ")}; do not apply stage exclusions to hiring matches.` : hiring && !funding ? "Funding-only announcements." : ""].filter(Boolean).join(" "),
      hasRecency: hiring || funding, extraFields: funding ? ["hiring_evidence", "stage", "raised", "category"] : ["hiring_evidence", "category"]},
  };
}
