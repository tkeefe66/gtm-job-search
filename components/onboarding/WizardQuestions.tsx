"use client";

import { useId, useState } from "react";
import type { WizardAnswers } from "@/lib/onboarding-wizard";
import { readCompanyInput } from "@/lib/company-input";
import s from "./Wizard.module.css";

export const QUESTION_TITLES = [
  "Let’s start with you.", "What would you like to do next?", "What would you like to use?",
  "Where would you like to work?", "What would make a role worth considering?", "What are your non-negotiables?",
  "What industries interest you?", "Any companies on your wish list?", "What should help us find companies?",
  "Choose what powers your search.", "Does this sound like you?",
];
export const QUESTION_INTROS = [
  "Upload or paste your résumé, or tell us briefly what you do. A few sentences are enough to start.",
  "Add the titles you would actually consider. Exploring a change? Describe the work instead.",
  "Choose tools or skills you want in your next role. An interest here does not claim experience you haven’t told us about.",
  "Choose the arrangements you would consider, then tell us where.",
  "Pick up to three. These help us understand what a good match means to you.",
  "Everything here is optional. Add only what would make you rule a job out.",
  "Choose a few, add your own, or keep your options open.",
  "Add a company name or careers-page link. We’ll confirm the name before adding it to your list.",
  "Choose either or both. These guide company research; you decide which suggestions to follow.",
  "Your provider bills API usage separately from a chat subscription. Connect before generating your search profile.",
  "Here’s what we understood. Edit your answers if something is wrong; we’ll rebuild the profile so the search rules stay consistent.",
];

export function Choice({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
  return <button type="button" className={s.chip} aria-pressed={selected} onClick={onClick}>{selected ? "✓ " : ""}{label}</button>;
}

function ListChoices({ label, options = [], value, onChange, limit = 20 }: { label: string; options?: string[]; value: string[]; onChange: (value: string[]) => void; limit?: number }) {
  const id = useId();
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  function toggle(item: string) {
    setError("");
    if (value.includes(item)) onChange(value.filter(v => v !== item));
    else if (value.length < limit) onChange([...value, item]);
    else setError(`Choose up to ${limit}. Remove one to add another.`);
  }
  return <>
    <div className={s.chips}>{Array.from(new Set([...options, ...value])).map(item => <Choice key={item} label={item} selected={value.includes(item)} onClick={() => toggle(item)} />)}</div>
    <form className={s.row} onSubmit={e => {
      e.preventDefault(); const item = text.trim(); if (!item) return;
      if (value.some(v => v.toLowerCase() === item.toLowerCase())) { setText(""); return; }
      toggle(item); if (value.length < limit) setText("");
    }}>
      <label htmlFor={id} className={s.sr}>{label}</label><input id={id} className={s.input} value={text} maxLength={100} placeholder={label} onChange={e => setText(e.target.value)} />
      <button className={s.secondary}>Add</button>
    </form>
    {error && <p className={s.error} role="alert">{error}</p>}
  </>;
}

function CompanyChoices({ value, onChange }: { value: WizardAnswers["companies"]; onChange: (value: WizardAnswers["companies"]) => void }) {
  const [text, setText] = useState("");
  const [candidate, setCandidate] = useState<{ name: string; careersUrl: string } | null>(null);
  const [error, setError] = useState("");
  function add(company: { name: string; careersUrl: string }) {
    if (!company.name.trim()) { setError("Enter the company’s name before confirming."); return; }
    if (readCompanyInput(company.name).kind === "url") { setError("Use the company name, not its URL, in the name field."); return; }
    if (value.length >= 20) { setError("Start with up to 20 companies. You can add more in Watchlist later."); return; }
    if (value.some(v => v.name.trim().toLowerCase() === company.name.trim().toLowerCase())) { setError("That company is already in your list."); return; }
    onChange([...value, { ...company, name: company.name.trim() }]); setText(""); setCandidate(null); setError("");
  }
  return <>
    <form className={s.row} onSubmit={e => { e.preventDefault(); setError(""); const parsed = readCompanyInput(text); if (parsed.kind === "empty") return;
      if (parsed.kind === "url") setCandidate({ name: parsed.suggestion, careersUrl: parsed.url });
      else add({ name: parsed.name, careersUrl: "" });
    }}><label htmlFor="wizard-company" className={s.sr}>Company name or careers-page link</label><input id="wizard-company" className={s.input} value={text} maxLength={1000} onChange={e => setText(e.target.value)} placeholder="Company name or careers-page link" /><button className={s.secondary}>Add</button></form>
    {candidate && <div className={s.note}>
      <p>Confirm which company this careers page belongs to.</p>
      <label className={s.field} htmlFor="wizard-company-name">Company name</label><input className={s.input} id="wizard-company-name" value={candidate.name} maxLength={100} onChange={e => setCandidate({ ...candidate, name: e.target.value })} />
      <p className={s.hint}>{candidate.careersUrl}</p><div className={s.row}><button type="button" className={s.secondary} onClick={() => add(candidate)}>Confirm company</button><button type="button" className={s.link} onClick={() => setCandidate(null)}>Cancel</button></div>
    </div>}
    {error && <p className={s.error} role="alert">{error}</p>}
    <ul className={s.list}>{value.map((c, i) => <li key={`${c.name}-${i}`} className={s.company}><span>{c.name}{c.careersUrl && <small>{c.careersUrl}</small>}</span><button type="button" className={s.link} aria-label={`Remove ${c.name}`} onClick={() => onChange(value.filter((_, n) => n !== i))}>Remove</button></li>)}</ul>
    <p className={s.hint}>These companies join your Watchlist when you finish. Scheduled checks use your AI account. Setup does not run a search.</p>
  </>;
}

export default function WizardQuestions({ step, answers: a, patch, upload, uploading, uploadNotice, skip }: {
  step: number; answers: WizardAnswers; patch: (change: Partial<WizardAnswers>) => void;
  upload: (file: File | undefined) => void; uploading: boolean; uploadNotice: string; skip: () => void;
}) {
  const toggle = (key: "workModes" | "priorities" | "fundingStages", item: string) => {
    const values = a[key]; if (key === "priorities" && values.length === 3 && !values.includes(item)) return;
    patch({ [key]: values.includes(item) ? values.filter(v => v !== item) : [...values, item] });
  };
  if (step === 0) return <>
    <div className={s.chips}><Choice label="Use my résumé" selected={a.mode === "resume"} onClick={() => patch({ mode: "resume" })} /><Choice label="Describe my experience" selected={a.mode === "questions"} onClick={() => patch({ mode: "questions" })} /></div>
    {a.mode === "resume" && <><label className={s.field} htmlFor="wizard-upload">Upload your résumé</label><input className={s.file} id="wizard-upload" type="file" accept=".pdf,.docx,.txt" disabled={uploading} onChange={e => { upload(e.target.files?.[0]); e.target.value = ""; }} /><p className={s.hint}>PDF, DOCX, or TXT, up to 1 MB. Text-based PDFs up to 10 pages.</p></>}
    {uploading && <p role="status">Reading your résumé…</p>}{uploadNotice && <p className={s.note} role="status">{uploadNotice}</p>}
    <label className={s.field} htmlFor="wizard-background">{a.mode === "resume" ? "Résumé text" : "Your experience"}</label>
    <textarea className={s.textarea} id="wizard-background" rows={8} maxLength={a.mode === "resume" ? 20000 : 4000} value={a.mode === "resume" ? a.resume : a.current} onChange={e => patch(a.mode === "resume" ? { resume: e.target.value } : { current: e.target.value })} placeholder="What do you do, and what experience would you like to build on?" />
    <p className={s.hint}>{a.mode === "resume" ? `${a.resume.length.toLocaleString()} / 20,000 characters. ` : ""}Your answers are saved to your account and sent to your selected AI provider only when you generate your profile.</p>
  </>;
  if (step === 1) return <><ListChoices label="Add a job title" value={a.titles} onChange={titles => patch({ titles })} /><label className={s.field} htmlFor="wizard-wanted">Or describe your next move</label><textarea id="wizard-wanted" className={s.textarea} value={a.wanted} maxLength={4000} onChange={e => patch({ wanted: e.target.value })} placeholder="Describe the work and level of responsibility you want next." /><p className={s.hint}>After connecting your key, we’ll suggest a search profile based on your background and goals.</p></>;
  if (step === 2) return <><ListChoices label="Add a tool or skill" value={a.tools} onChange={tools => patch({ tools })} /><p className={s.hint}>Think software, methods, equipment, or specialties: SQL, CAD, financial modeling, or patient care.</p><button className={s.link} type="button" onClick={skip}>No preference — skip this</button></>;
  if (step === 3) return <><div className={s.chips}>{["Remote", "Hybrid", "On-site"].map(v => <Choice key={v} label={v} selected={a.workModes.includes(v)} onClick={() => toggle("workModes", v)} />)}</div><label className={s.field} htmlFor="wizard-location">Location or region</label><input id="wizard-location" className={s.input} value={a.location} maxLength={1000} onChange={e => patch({ location: e.target.value })} placeholder="City, state, country, or eligible remote region" /><label className={s.field} htmlFor="wizard-location-importance">How firm is this?</label><select id="wizard-location-importance" className={s.select} value={a.locationImportance} onChange={e => patch({ locationImportance: e.target.value as WizardAnswers["locationImportance"] })}><option value="preference">Preference</option><option value="required">Must-have</option></select><p className={s.hint}>Remote jobs can still have location restrictions. Include where you can work, or enter “Anywhere” if location is open.</p></>;
  if (step === 4) return <><div className={s.chips}>{["Compensation", "Leading a team", "Hands-on work", "Flexibility", "Career growth", "Stability"].map(v => <button type="button" key={v} className={s.chip} aria-pressed={a.priorities.includes(v)} disabled={a.priorities.length >= 3 && !a.priorities.includes(v)} onClick={() => toggle("priorities", v)}>{a.priorities.includes(v) ? "✓ " : ""}{v}</button>)}</div><p className={s.hint} aria-live="polite">{a.priorities.length} of 3 selected</p><button className={s.link} type="button" onClick={skip}>No preference yet</button></>;
  if (step === 5) return <><label className={s.field} htmlFor="wizard-salary">Minimum annual base salary (USD)</label><input id="wizard-salary" className={s.input} type="number" min={1} step={1} value={a.compFloor} onChange={e => patch({ compFloor: e.target.value })} placeholder="No minimum" /><label className={s.field} htmlFor="wizard-travel">Travel</label><select id="wizard-travel" className={s.select} value={a.travel} onChange={e => patch({ travel: e.target.value })}>{["No preference", "No travel", "Occasional travel only", "Up to 25% travel"].map(v => <option key={v}>{v}</option>)}</select><label className={s.field} htmlFor="wizard-exclusions">Anything else to avoid?</label><textarea id="wizard-exclusions" className={s.textarea} maxLength={4000} value={a.exclusions} onChange={e => patch({ exclusions: e.target.value })} placeholder="Industries, responsibilities, schedules, or anything else that would be a dealbreaker." /></>;
  if (step === 6) return <><ListChoices label="Add another industry" options={["Healthcare technology", "Software", "Financial services", "Education", "Manufacturing", "Climate & energy"]} value={a.industries} onChange={industries => patch({ industries })} /><button className={s.link} type="button" onClick={skip}>I’m open to any industry</button></>;
  if (step === 7) return <><CompanyChoices value={a.companies} onChange={companies => patch({ companies })} /><button className={s.link} type="button" onClick={skip}>Help me discover companies instead</button></>;
  if (step === 8) return <>
    {([['hiring', 'Relevant hiring', 'Look for companies advertising roles related to your target work.'], ['funding', 'Funding news', 'Look for companies announcing investment. A useful reason to investigate, even before the right role appears.']] as const).map(([value, label, help]) => <button type="button" className={s.option} key={value} aria-pressed={a.signals.includes(value)} onClick={() => patch({ signals: a.signals.includes(value) ? a.signals.filter(v => v !== value) : [...a.signals, value] })}><span className={s.check}>{a.signals.includes(value) ? "✓" : ""}</span><span><strong>{label}</strong><small>{help}</small></span></button>)}
    {a.signals.includes("funding") && <><p className={s.field}>Any funding stage you prefer? <span className={s.hint}>Optional</span></p><div className={s.chips}>{["Seed / early stage", "Series A", "Series B or later"].map(v => <Choice key={v} label={v} selected={a.fundingStages.includes(v)} onClick={() => toggle("fundingStages", v)} />)}</div><p className={s.hint}>No selection means any funding stage. Funding does not guarantee hiring, stability, or a good fit.</p></>}
    <button className={s.link} type="button" onClick={skip}>No preference — keep discovery broad</button>
  </>;
  return null;
}
