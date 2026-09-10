import type { ReactNode } from "react";
import type { WizardAnswers } from "@/lib/onboarding-wizard";
import type { GeneratedProfile } from "@/lib/onboarding-prompt";
import s from "./Wizard.module.css";
function Section({ title, children, step, edit }: { title: string; children: ReactNode; step: number; edit: (step: number) => void }) {
  return <section className={s.summary}><button type="button" aria-label={`Edit ${title}`} onClick={() => edit(step)}>Edit</button><h2>{title}</h2><p>{children}</p></section>;
}
export default function WizardReview({ answers: a, generated, edit }: { answers: WizardAnswers; generated?: GeneratedProfile; edit: (step: number) => void }) {
  return <>
    {!generated && <p className={s.note}>Your answers have changed. Rebuild your profile before finishing so the search and matching rules reflect your edits.</p>}
    <Section title="Your next role" step={1} edit={edit}>{(generated?.titles ?? a.titles).join(", ") || "We’ll suggest titles from your goals."}{a.wanted && `\n${a.wanted}`}</Section>
    <Section title="Where you’ll work" step={3} edit={edit}>{a.workModes.join(", ") || "Any arrangement"}{`\n${a.location || "Remote — location not specified"}`} · {a.locationImportance === "required" ? "Must-have" : "Preference"}{generated?.locationRule && `\n${generated.locationRule}`}</Section>
    <Section title="Tools & skills you want to use" step={2} edit={edit}>{a.tools.join(", ") || "No preference"}</Section>
    <Section title="What matters most" step={4} edit={edit}>{a.priorities.join(", ") || "No priorities selected"}</Section>
    <Section title="Dealbreakers" step={5} edit={edit}>{a.compFloor ? `At least $${Number(a.compFloor).toLocaleString("en-US")} USD annual base` : "No salary minimum"}{`\nTravel: ${a.travel || "No preference"}`}{a.exclusions && `\n${a.exclusions}`}</Section>
    <Section title="Industries" step={6} edit={edit}>{a.industries.join(", ") || "Open to any industry"}</Section>
    <Section title="Companies to follow" step={7} edit={edit}>{a.companies.map(c => c.name).join(", ") || "Start with discovery suggestions"}</Section>
    <Section title="Discovery interests" step={8} edit={edit}>{a.signals.map(v => v === "funding" ? "Funding news" : "Relevant hiring").join(" and ") || "Broad company discovery"}{a.signals.includes("funding") && `\nFunding stages: ${a.fundingStages.join(", ") || "Any stage"}`}</Section>
    <Section title="How we’ll assess a match" step={0} edit={edit}>{generated?.fitBrain || "Generate your profile to review what the app understands about your experience."}</Section>
    <p className={s.note}>Finishing saves these preferences and adds the companies you chose to your Watchlist. Scheduled checks use your AI account. Discovered companies remain suggestions until you choose to follow them.</p>
  </>;
}
