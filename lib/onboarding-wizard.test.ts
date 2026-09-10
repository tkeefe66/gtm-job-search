import { describe, expect, it } from "vitest";
import { emptyWizardAnswers, resolveWizardAnswers, wizardStepError, wizardPromptAnswers, applyWizardPreferences } from "./onboarding-wizard";
import { DEFAULT_PROFILE, resolveProfile } from "./profile";

describe("wizard answers", () => {
  it("retains a long uploaded resume and hydrates old location and exclusions", () => {
    const a = resolveWizardAnswers({resume: "x".repeat(16000), where: "Boston", dealbreakers: "No agencies"});
    expect(a.resume).toHaveLength(16000);
    expect(a.location).toBe("Boston");
    expect(a.exclusions).toBe("No agencies");
    expect(resolveProfile({answers: a}).answers.resume).toHaveLength(16000);
  });
  it("requires confirmed company identity and a usable careers URL", () => {
    const a = emptyWizardAnswers();
    a.companies = [{name: "https://acme.com/jobs", careersUrl: "https://acme.com/jobs"}];
    expect(wizardStepError(a, 7)).toBeTruthy();
    a.companies = [{name: "Acme", careersUrl: "javascript:alert(1)"}];
    expect(wizardStepError(a, 7)).toBeTruthy();
    a.companies[0].careersUrl = "https://acme.com/jobs";
    expect(wizardStepError(a, 7)).toBeUndefined();
  });
  it("accepts named companies without URLs, broad discovery and funding at any stage", () => {
    const a = {...emptyWizardAnswers(), companies: [{name: "Acme", careersUrl: ""}], signals: [] as ("hiring" | "funding")[]};
    expect(wizardStepError(a, 7)).toBeUndefined();
    expect(wizardStepError(a, 8)).toBeUndefined();
    const generated = {...DEFAULT_PROFILE, titles: ["Nurse"], locations: ["Boston"], stackTerms: [], locationRule: "Boston"};
    const broad = applyWizardPreferences(generated, a);
    expect(broad.hiringSignal.hasRecency).toBe(false);
    expect(broad.hiringSignal.qualifier).toContain("without requiring");
    a.signals = ["funding"];
    expect(wizardStepError(a, 8)).toBeUndefined();
    const funding = applyWizardPreferences(generated, a);
    expect(funding.hiringSignal.qualifier).toContain("any funding stage");
    expect(funding.hiringSignal.exclusions).toBe("");
  });
  it("labels tools as desired work and constrains funding without excluding hiring", () => {
    const a = {...emptyWizardAnswers(), tools: ["Python"], industries: ["Healthcare"], signals: ["hiring", "funding"] as ("hiring"|"funding")[], fundingStages: ["Series B"], exclusions: "Agencies"};
    expect(wizardPromptAnswers(a).wanted).toContain("not evidence of experience");
    const p = applyWizardPreferences({...DEFAULT_PROFILE, titles: ["Nurse"], locations: ["Boston"], stackTerms: [], locationRule: "Boston"}, a);
    expect(p.stackTerms).toEqual(["Python"]);
    expect(p.hiringSignal.qualifier).toContain("Healthcare");
    expect(p.hiringSignal.qualifier).toContain("Series B");
    expect(p.hiringSignal.exclusions).toContain("Agencies");
    expect(p.hiringSignal.exclusions).toContain("funding matches only");
  });
});
