"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { getWizardState, saveWizardProgress, generateWizardProfile, finishWizardOnboarding, clearWizardProgress } from "@/app/actions/onboarding-wizard";
import { getApiKeyStatus, type ApiKeyStatus } from "@/app/actions/api-key";
import { readResumeUpload } from "@/app/actions/resume-upload";
import { getSettings, markCompScoringRescored, rescoreAll } from "@/app/actions/settings";
import { emptyWizardAnswers, wizardStepError, type WizardAnswers } from "@/lib/onboarding-wizard";
import { type GeneratedProfile, RESUME_MAX_CHARS } from "@/lib/onboarding-prompt";
import { describeWriteFailure } from "@/lib/write-failure";
import { serialSave } from "@/lib/serial-save";
import { onboardingRescoreOffer, passDrained, rescorePromptQuestion, rescoreSummary, runRescorePass } from "@/lib/rescore-progress";
import { isSupportedProvider } from "@/lib/providers/catalog";
import ApiKeyPanel from "./ApiKeyPanel";
import WizardQuestions, { QUESTION_TITLES, QUESTION_INTROS } from "./onboarding/WizardQuestions";
import WizardReview from "./onboarding/WizardReview";
import s from "./onboarding/Wizard.module.css";

const groups = ["Your background", "Your next role", "What matters", "Companies", "Connect & review"];
const groupFor = (n: number) => n === 0 ? 0 : n <= 3 ? 1 : n <= 5 ? 2 : n <= 8 ? 3 : 4;
const signature = (answers: WizardAnswers, step: number) => JSON.stringify({ answers, step });
type SaveState = "saved" | "pending" | "saving" | "failed";

export default function Onboarding() {
  const [answers, setAnswers] = useState<WizardAnswers>(emptyWizardAnswers);
  const [step, setStep] = useState(0);
  const [generated, setGenerated] = useState<GeneratedProfile>();
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [error, setError] = useState<string>();
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadNotice, setUploadNotice] = useState("");
  const [editing, setEditing] = useState(false);
  const [done, setDone] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [wasOnboarded, setWasOnboarded] = useState(false);
  const [keyStatus, setKeyStatus] = useState<ApiKeyStatus | null>(null);
  const [keyReady, setKeyReady] = useState(false);
  const [rescoreCount, setRescoreCount] = useState<number | null>();
  const [rescoreNotice, setRescoreNotice] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const queue = useRef(serialSave(({ answers: a, step: n }: { answers: WizardAnswers; step: number }) => saveWizardProgress(a, n)));
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const revision = useRef(0);
  const saved = useRef("");
  const latest = useRef({ answers, step });
  const heading = useRef<HTMLHeadingElement>(null);
  latest.current = { answers, step };

  const persist = useCallback(async (a: WizardAnswers, n: number): Promise<boolean> => {
    const version = ++revision.current;
    setSaveState("saving");
    try {
      const result = await queue.current({ answers: a, step: n });
      const failure = describeWriteFailure(result.error, "save your progress");
      if (failure !== undefined) {
        if (version === revision.current) { setSaveState("failed"); setError(failure); }
        return false;
      }
      saved.current = signature(a, n);
      if (version === revision.current) setSaveState(saved.current === signature(latest.current.answers, latest.current.step) ? "saved" : "pending");
      return true;
    } catch {
      if (version === revision.current) { setSaveState("failed"); setError("Could not save your progress. Check your connection and retry before leaving."); }
      return false;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [state, key] = await Promise.all([getWizardState(), getApiKeyStatus()]);
        if (cancelled) return;
        if (state.error !== undefined) { setLoadError(state.error || "Could not load your saved progress. Reload to try again."); return; }
        const n = state.draft.generated ? 10 : Math.min(9, state.draft.step);
        setAnswers(state.draft.answers); setStep(n); setGenerated(state.draft.generated);
        saved.current = signature(state.draft.answers, n);
        setWasOnboarded(state.onboardedAt !== null); setIsAdmin(state.isAdmin);
        setKeyStatus(key.error === undefined ? key : null); setKeyReady(key.error === undefined && key.present && key.status === "ok"); setReady(true);
      } catch { if (!cancelled) setLoadError("Could not load onboarding. Check your connection and reload this page."); }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    clearTimeout(timer.current);
    if (!ready || done || busy || uploading || saved.current === signature(answers, step)) return;
    timer.current = setTimeout(() => { void persist(answers, step); }, 700);
    return () => clearTimeout(timer.current);
  }, [answers, step, ready, done, busy, uploading, persist]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (saveState !== "saved" || busy) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [saveState, busy]);
  useEffect(() => { heading.current?.focus(); }, [step, ready, done]);

  function patch(change: Partial<WizardAnswers>) {
    setAnswers(a => ({ ...a, ...change })); setGenerated(undefined); setSaveState("pending"); setError(undefined);
  }
  async function move(next: number, changed = answers, validate = true, keepEditing = false) {
    if (busy || uploading) return;
    const failure = validate ? wizardStepError(changed, step) : undefined;
    if (failure !== undefined) { setError(failure); return; }
    clearTimeout(timer.current); setBusy(true); setError(undefined);
    try { if (await persist(changed, next)) { setAnswers(changed); setStep(next); setEditing(keepEditing); setSaveState("saved"); } }
    finally { setBusy(false); }
  }
  function skip() {
    const next = { ...answers };
    if (step === 2) next.tools = [];
    if (step === 4) next.priorities = [];
    if (step === 6) next.industries = [];
    if (step === 7) next.companies = [];
    if (step === 8) { next.signals = []; next.fundingStages = []; }
    setGenerated(undefined); void move(editing ? 10 : step + 1, next);
  }
  async function upload(file: File | undefined) {
    if (!file) return;
    setUploading(true); setUploadNotice(""); setError(undefined);
    try {
      if (file.size > 1024 * 1024) { setError("Choose a résumé smaller than 1 MB, or paste its text."); return; }
      const form = new FormData(); form.set("resume", file);
      const result = await readResumeUpload(form);
      if (result.error !== undefined) { setError(result.error || "Could not read the résumé. Paste its text instead."); return; }
      const text = result.text ?? "";
      patch({ resume: text.slice(0, RESUME_MAX_CHARS), mode: "resume" });
      setUploadNotice(text.length > RESUME_MAX_CHARS ? "Résumé imported. Only the first 20,000 characters fit; review or shorten the text below before continuing." : "Résumé text imported. Review it below before continuing.");
    } catch { setError("Could not upload your résumé. Check your connection or paste its text instead."); }
    finally { setUploading(false); }
  }
  async function generate() {
    clearTimeout(timer.current); setBusy(true); setGenerating(true); setError(undefined);
    try {
      if (!await persist(answers, 9)) return;
      const key = await getApiKeyStatus();
      if (key.error !== undefined) { setError(key.error || "Could not check your API key. Retry before generating."); return; }
      setKeyStatus(key);
      if (!isAdmin && (!key.present || key.status !== "ok")) { setKeyReady(false); setStep(9); setError("Connect and verify your API key before generating."); return; }
      const result = await generateWizardProfile(answers);
      if (result.error !== undefined || result.capped !== undefined) { setError(result.error || result.capped || "Could not build your profile. Please retry."); return; }
      if (!result.profile) { setError("No profile was returned. Your answers are saved; please retry."); return; }
      setGenerated(result.profile); setStep(10); saved.current = signature(answers, 10); setSaveState("saved");
    } catch { setError("Could not complete profile generation. Reload to check for a saved result before retrying; your provider may have charged for the request."); }
    finally { setBusy(false); setGenerating(false); }
  }
  async function finish() {
    clearTimeout(timer.current); setBusy(true); setError(undefined);
    try {
      if (!await persist(answers, 10)) return;
      const result = await finishWizardOnboarding(answers);
      const failure = describeWriteFailure(result.error, "finish your setup");
      if (failure !== undefined) { setError(failure); return; }
      setDone(true); setSaveState("saved");
      if (wasOnboarded) {
        try { const state = await getSettings(); setRescoreCount(state.error !== undefined ? null : state.scoredJobCount > 0 ? state.scoredJobCount : undefined); }
        catch { setRescoreCount(null); }
      }
    } catch { setError("Could not confirm your setup was saved. Reload to check your progress before trying again."); }
    finally { setBusy(false); }
  }
  async function clear() {
    if (uploading || busy) return;
    clearTimeout(timer.current); setBusy(true); setError(undefined);
    try {
      // Drain prior writes before deletion, so a late autosave cannot restore the résumé.
      await queue.current.drain();
      const result = await clearWizardProgress();
      const failure = describeWriteFailure(result.error, "clear your saved answers");
      if (failure !== undefined) { setError(failure); return; }
      const empty = emptyWizardAnswers(); setAnswers(empty); setStep(0); setGenerated(undefined); setEditing(false); setConfirmClear(false); saved.current = signature(empty, 0); setSaveState("saved");
    } catch { setError("Could not clear your answers. Check your connection and try again."); }
    finally { setBusy(false); }
  }
  async function rescore() {
    setBusy(true); setError(undefined);
    try {
      const pass = await runRescorePass({ total: rescoreCount ?? 100000, runBatch: args => rescoreAll(args), onProgress: t => setRescoreNotice(rescoreSummary(t)) });
      setRescoreNotice(rescoreSummary(pass));
      if (pass.error !== undefined) setError(pass.error || "Rescoring failed. Retry to finish remaining roles.");
      if (passDrained(pass)) { const stamp = await markCompScoringRescored(pass); if (stamp.error !== undefined) setError(stamp.error || "The rescore finished, but its completion could not be saved."); setRescoreCount(undefined); }
    } catch { setError("Rescoring stopped. You can retry to finish the remaining roles."); }
    finally { setBusy(false); }
  }

  if (loadError !== undefined) return <div className={s.wizard}><h1 className={s.title}>Let’s recover your progress.</h1><p className={s.error} role="alert">{loadError}</p><button className={s.secondary} onClick={() => window.location.reload()}>Reload saved progress</button></div>;
  if (!ready) return <div className={s.wizard}><p role="status">Loading your saved progress…</p></div>;
  const group = groupFor(step);
  const offer = rescoreCount ? onboardingRescoreOffer({ scoredJobCount: rescoreCount, wasAlreadyOnboarded: true, dismissed: false }) : null;
  return <div className={s.wizard}>
    <header className={s.header}><span className={s.brand}>Your next chapter.</span><span className={s.status} role="status">{done ? "Profile saved" : saveState === "saved" ? "Progress saved to your account" : saveState === "failed" ? "Progress not saved" : saveState === "saving" ? "Saving progress…" : "Unsaved changes"}</span></header>
    <div className={s.layout}><nav aria-label="Setup progress"><ol className={s.progress}>{groups.map((g, i) => <li key={g} aria-current={i === group ? "step" : undefined}><span className={s.number}>{i < group ? "✓" : i + 1}</span><span className={s.stepLabel}>{g}</span></li>)}</ol></nav>
      <main className={s.main}>
        {!done && <div className={s.bar} aria-hidden="true"><span style={{ width: `${(step + 1) / 11 * 100}%` }} /></div>}
        <p className={s.eyebrow}>{done ? "Ready when you are" : `${groups[group]} · ${step + 1} of 11`}</p>
        <h1 className={s.title} ref={heading} tabIndex={-1}>{done ? "Your search is ready." : QUESTION_TITLES[step]}</h1>
        <p className={s.intro}>{done ? "Your profile is saved. Choose where to begin." : QUESTION_INTROS[step]}</p>
        <fieldset className={s.fieldset} disabled={busy || uploading}>
          {!done && step < 9 && <WizardQuestions key={step} step={step} answers={answers} patch={patch} upload={file => void upload(file)} uploading={uploading} uploadNotice={uploadNotice} skip={skip} />}
          {!done && step === 9 && <><ApiKeyPanel compact isAdmin={isAdmin} onReady={setKeyReady} onStatusChange={setKeyStatus} /><p className={s.note}>Build your profile when you’re ready. This makes an AI request using your selected provider. It does not start a job search.</p>{generating && <p role="status">Building your search profile… This can take a minute. Your answers are saved.</p>}</>}
          {!done && step === 10 && <WizardReview answers={answers} generated={generated} edit={n => void move(n, answers, false, true)} />}
          {done && <>
            {keyStatus?.provider === "google" && <p className={s.note}>With Gemini, start by checking a job you already found. Switch to Anthropic or OpenAI in Settings to use By Role search.</p>}
            <div className={s.doneLinks}>{keyStatus?.provider !== "google" && <Link className={s.primary} href="/discover?mode=role">Find my first roles →</Link>}<Link className={s.secondary} href="/roles?add=1">Check a job I already found →</Link>{answers.companies.length > 0 && <Link className={s.link} href="/watchlist">View my Watchlist</Link>}</div>
            {rescoreCount !== undefined && <div className={s.note}><p>{offer ? rescorePromptQuestion(offer, rescoreCount ?? 0, { provider: isSupportedProvider(keyStatus?.provider ?? "") ? keyStatus?.provider as "anthropic" | "openai" | "google" : undefined, model: keyStatus?.model ?? undefined }) : "Your profile changed. We couldn’t count existing scored roles. You can rescore them now using your AI account, or do it later in Settings."}</p><button className={s.secondary} onClick={() => void rescore()}>Rescore existing roles</button></div>}
            {rescoreNotice && <p role="status" className={s.note}>{rescoreNotice}</p>}
          </>}
        </fieldset>
        {error !== undefined && <p className={s.error} role="alert">{error}</p>}
        {!done && <>
          {saveState === "failed" && <button disabled={busy} className={s.secondary} onClick={() => { setError(undefined); void persist(answers, step); }}>Retry saving progress</button>}
          <div className={s.footer}><button className={s.link} disabled={busy || uploading || step === 0} onClick={() => void move(step - 1, answers, false)}>Back</button>
            {step === 9 ? <button className={s.primary} disabled={busy || (!keyReady && !isAdmin)} onClick={() => void generate()}>{generating ? "Building profile…" : "Build my profile →"}</button>
              : step === 10 ? generated ? <button className={s.primary} disabled={busy} onClick={() => void finish()}>{busy ? "Saving…" : "Save my search →"}</button> : <button className={s.primary} disabled={busy} onClick={() => void move(9, answers, false)}>Rebuild my profile →</button>
              : <button className={s.primary} disabled={busy || uploading} onClick={() => void move(editing ? 10 : step + 1)}>{busy ? "Saving…" : editing ? "Return to review →" : "Continue →"}</button>}
          </div>
          <div className={s.hint}>{confirmClear ? <><p>Clear this wizard’s saved answers and generated draft? Your active search profile stays in place.</p><button className={s.link} disabled={busy || uploading} onClick={() => void clear()}>Clear saved answers</button>{" · "}<button className={s.link} disabled={busy} onClick={() => setConfirmClear(false)}>Keep my progress</button></> : <button className={s.link} disabled={busy || uploading} onClick={() => setConfirmClear(true)}>Clear saved wizard answers</button>}</div>
        </>}
      </main>
    </div>
  </div>;
}
