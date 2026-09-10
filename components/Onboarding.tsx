"use client";

import React, { useEffect, useState, useId, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  clearAnswers,
  generateProfile,
  getOnboardingState,
  saveAnswers,
  saveProfile,
} from "@/app/actions/onboarding";
import { readResumeUpload } from "@/app/actions/resume-upload";
import type { ApiKeyStatus } from "@/app/actions/api-key";
import { isSupportedProvider } from "@/lib/providers/catalog";
import { getApiKeyStatus } from "@/app/actions/api-key";
import { scoreFit } from "@/app/actions/parse-role";
import { getSettings, markCompScoringRescored, rescoreAll } from "@/app/actions/settings";

// Type-only imports. lib/profile.ts and lib/onboarding-rules.ts are safe to
// pull in at RUNTIME too (see their own header comments — neither reaches
// `pg`), which is what makes DEFAULT_PROFILE, profileToFitInputs, keyStepCopy,
// and sampleRoleFor usable as real values below rather than just types.
import { DEFAULT_PROFILE, profileToFitInputs, type OnboardingAnswers } from "@/lib/profile";
import { answersAreComplete, keyStepCopy, sampleRoleFor } from "@/lib/onboarding-rules";
import {
  draftFromGenerated,
  payloadFrom,
  toList,
  type ProfileDraft,
} from "@/lib/onboarding-draft";
import {
  onboardingRescoreOffer,
  passDrained,
  rescoreErrorText,
  rescorePromptQuestion,
  rescoreSummary,
  runRescorePass,
  type RescoreReason,
} from "@/lib/rescore-progress";

import ApiKeyPanel from "./ApiKeyPanel";
import { Spinner } from "./ui";

// Four setup stages, followed by first-action choices or the existing rescore offer.
type Step = "loading" | "key" | "door" | "answers" | "preferences" | "generating" | "review" | "rescore" | "done";

type Section = "key" | "answers" | "generate" | "sample" | "finish" | "rescore";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Sized generously rather than derived, for the one case that needs it: the
 * "could not confirm your scored-role count" branch of handleFinish (Finding
 * 2). maxRescoreBatches uses this only as a CEILING on how many batches a
 * pass may run — real progress (shouldContinueRescore) is what actually stops
 * it — so an unknown count is safer served by a large ceiling than by a small
 * or zero one, which would silently cap a real rescore at one batch.
 */
const UNKNOWN_RESCORE_BUDGET = 100_000;

export default function Onboarding() {
  const router = useRouter();

  const [step, setStep] = useState<Step>("loading");
  // Presence, not truthiness. A NON-NULL loadError means getOnboardingState's
  // read failed, and `answers` in that case is DEFAULT_PROFILE's EMPTY
  // defaults — never the tenant's real stored answers (see the mount effect
  // below). Rendering the wizard on those and letting Finish reach saveProfile
  // would silently overwrite a real, previously-saved answers/résumé with
  // nothing. So this flag fully blocks the wizard rather than just warning —
  // stronger than /settings' settingsReadWarning, which can afford to keep
  // rendering because each of its sections saves independently; onboarding's
  // answers are all-or-nothing at Finish, so there is no safe partial render.
  const [loadError, setLoadError] = useState<string | null>(null);

  const [answers, setAnswers] = useState<OnboardingAnswers>(DEFAULT_PROFILE.answers);
  // Read once, at mount, before this run can have changed it. A first run has
  // nothing to rescore — see onboardingRescoreOffer in lib/rescore-progress.ts.
  const [wasAlreadyOnboarded, setWasAlreadyOnboarded] = useState(false);
  const [connectedKey, setConnectedKey] = useState<ApiKeyStatus | null>(null);
  const [keyReady, setKeyReady] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [compFloor, setCompFloor] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { headingRef.current?.focus(); }, [step]);

  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const [showMore, setShowMore] = useState(false);

  const [busy, setBusy] = useState<Partial<Record<Section, boolean>>>({});
  const [errors, setErrors] = useState<Partial<Record<Section, string>>>({});

  // A capped generateProfile result is a REQUIREMENT, not a failure — kept
  // apart from `errors.generate` so it renders with the key field attached
  // rather than as "something went wrong".
  const [cappedMessage, setCappedMessage] = useState<string | null>(null);

  const [sampleResult, setSampleResult] = useState<{
    score: number;
    rationale: string;
    roleTitle: string;
  } | null>(null);
  const [sampleError, setSampleError] = useState<string | null>(null);

  const [rescoreReason, setRescoreReason] = useState<RescoreReason | null>(null);
  const [rescoreCount, setRescoreCount] = useState(0);
  // Set when getSettings() itself failed after Finish, so scoredJobCount could
  // not be confirmed — see handleFinish. Kept apart from rescoreReason because
  // rescorePromptQuestion's wording quotes an exact count and a dollar figure,
  // neither of which can be stated honestly here.
  const [rescoreUnknown, setRescoreUnknown] = useState(false);
  const [rescoring, setRescoring] = useState(false);
  const [rescoreNotice, setRescoreNotice] = useState<string | null>(null);
  const [rescoreError, setRescoreError] = useState<string | null>(null);
  const [rescoreDone, setRescoreDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [state, keyStatus] = await Promise.all([getOnboardingState(), getApiKeyStatus()]);
        if (cancelled) return;
        // Presence, not truthiness — the message can be empty. On a failed
        // read, `state.answers` is DEFAULT_PROFILE's EMPTY defaults (see
        // getOnboardingState's own fallback) — NOT the tenant's real stored
        // answers, so it is deliberately not applied here. loadError being set
        // blocks the whole wizard below (Finding 1); nothing downstream of
        // this branch can reach Finish, so there is nothing to guard by
        // skipping setWasAlreadyOnboarded / setStep too.
        if (state.error !== undefined) {
          setLoadError(state.error || "Could not read your saved answers. Reload to try again.");
          return;
        }
        setAnswers(state.answers);
        setWasAlreadyOnboarded(
          state.onboardedAt !== null && state.onboardedAt.length > 0
        );
        setConnectedKey(keyStatus.error === undefined ? keyStatus : null);
        setKeyReady(keyStatus.error === undefined && keyStatus.present && keyStatus.status === "ok");
        setIsAdmin(state.isAdmin);
        setCompFloor(state.compFloor === null ? "" : String(state.compFloor));
        setStep("door");
      } catch (err) {
        if (!cancelled) setLoadError(`Could not load onboarding — ${message(err)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const stepIndex = step === "door" || step === "answers" ? 0 : step === "preferences" ? 1 : step === "key" || step === "generating" ? 2 : 3;

  async function handleKeyContinue() {
    setBusy(b => ({ ...b, key: true }));
    setErrors(e => ({ ...e, key: undefined }));
    try {
      const status = await getApiKeyStatus();
      if (status.error !== undefined) {
        setErrors(e => ({ ...e, key: status.error || "Could not check your key. Please try again." }));
        return;
      }
      if (!isAdmin && (!status.present || status.status !== "ok")) {
        setKeyReady(false);
        setErrors(e => ({ ...e, key: "Save and verify your selected provider’s API key before continuing." }));
        return;
      }
      setStep("generating");
    } catch {
      setErrors(e => ({ ...e, key: "Could not check your key. Check your connection and try again." }));
    } finally { setBusy(b => ({ ...b, key: false })); }
  }

  async function handleUpload(file: File | undefined) {
    if (!file) return;
    setUploading(true); setUploadError(null);
    try {
      if (file.size > 1024 * 1024) { setUploadError("Choose a file smaller than 1 MB, or paste its text."); return; }
      const form = new FormData();
      form.set("resume", file);
      const result = await readResumeUpload(form);
      if (result.error !== undefined) { setUploadError(result.error || "Could not read the file. Paste its text instead."); return; }
      setAnswers(a => ({ ...a, resume: result.text ?? "" }));
    } catch { setUploadError("Could not upload your résumé. Check your connection or paste its text instead."); }
    finally { setUploading(false); }
  }

  function chooseMode(mode: OnboardingAnswers["mode"]) {
    setAnswers((a) => ({ ...a, mode }));
    setStep("answers");
  }

  async function handleContinueFromAnswers() {
    if (compFloor.trim() && (!Number.isSafeInteger(Number(compFloor)) || Number(compFloor) < 1)) {
      setErrors(e => ({ ...e, answers: "Enter a whole annual salary in USD, or leave it blank." }));
      return;
    }
    if (!answersAreComplete(answers)) {
      setErrors((e) => ({
        ...e,
        answers: "Answer what you want next and where you'll work before generating.",
      }));
      return;
    }
    setBusy((b) => ({ ...b, answers: true }));
    setErrors((e) => ({ ...e, answers: undefined }));
    try {
      // Fires BEFORE Step 3, not at Finish — the answers cost nothing to
      // store and are the whole input to a call the user pays for.
      const res = await saveAnswers(answers);
      if (res.error !== undefined) {
        setErrors((e) => ({ ...e, answers: res.error }));
        return;
      }
      setStep(keyReady || isAdmin ? "generating" : "key");
    } catch (err) {
      setErrors((e) => ({ ...e, answers: message(err) }));
    } finally {
      setBusy((b) => ({ ...b, answers: false }));
    }
  }

  async function handleClearAnswers() {
    setBusy((b) => ({ ...b, answers: true }));
    setErrors((e) => ({ ...e, answers: undefined }));
    try {
      const res = await clearAnswers();
      if (res.error !== undefined) {
        setErrors((e) => ({ ...e, answers: res.error }));
        return;
      }
      setAnswers((a) => ({ ...DEFAULT_PROFILE.answers, mode: a.mode }));
    } catch (err) {
      setErrors((e) => ({ ...e, answers: message(err) }));
    } finally {
      setBusy((b) => ({ ...b, answers: false }));
    }
  }

  async function handleGenerate() {
    setBusy((b) => ({ ...b, generate: true }));
    setErrors((e) => ({ ...e, generate: undefined }));
    setCappedMessage(null);
    try {
      const res = await generateProfile(answers);
      if (res.capped !== undefined) {
        setCappedMessage(res.capped);
        return;
      }
      if (res.error !== undefined) {
        setErrors((e) => ({ ...e, generate: res.error }));
        return;
      }
      setDraft(draftFromGenerated(res.profile!));
      setSampleResult(null);
      setSampleError(null);
      setShowMore(false);
      setStep("review");
    } catch (err) {
      setErrors((e) => ({ ...e, generate: message(err) }));
    } finally {
      setBusy((b) => ({ ...b, generate: false }));
    }
  }

  function updateDraft<K extends keyof ProfileDraft>(key: K, value: ProfileDraft[K]) {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  }

  async function handleSampleScore() {
    if (!draft || !draft.fitBrain.trim()) return;
    setBusy((b) => ({ ...b, sample: true }));
    setSampleError(null);
    setSampleResult(null);
    try {
      const titles = toList(draft.titles);
      const locations = toList(draft.locations);
      const role = sampleRoleFor({ titles, locations });
      const fitInputs = profileToFitInputs(payloadFrom(draft, answers), compFloor.trim() ? Number(compFloor) : null);
      const res = await scoreFit({ ...role, fitInputs });
      if (res.error !== undefined) {
        setSampleError(res.error);
        return;
      }
      setSampleResult({ score: res.score, rationale: res.rationale, roleTitle: role.role_title });
    } catch (err) {
      setSampleError(`Could not score the sample — ${message(err)}`);
    } finally {
      setBusy((b) => ({ ...b, sample: false }));
    }
  }

  function handleStartOver() {
    setDraft(null);
    setSampleResult(null);
    setSampleError(null);
    setErrors((e) => ({ ...e, finish: undefined, generate: undefined }));
    setCappedMessage(null);
    setStep("answers");
  }

  async function handleFinish() {
    if (!draft) return;
    const brain = draft.fitBrain.trim();
    if (!brain) {
      setErrors((e) => ({
        ...e,
        finish: "Add a description of yourself before finishing — every role is scored against this.",
      }));
      return;
    }
    setBusy((b) => ({ ...b, finish: true }));
    setErrors((e) => ({ ...e, finish: undefined }));
    try {
      const res = await saveProfile(payloadFrom(draft, answers), { compFloor: compFloor.trim() ? Number(compFloor) : null });
      if (res.error !== undefined) {
        setErrors((e) => ({ ...e, finish: res.error }));
        return;
      }

      // A re-run replaces the fit brain wholesale, which makes every existing
      // score stale. Offered here, not left for /settings, because a user who
      // never opens /settings would otherwise never see it — see
      // onboardingRescoreOffer in lib/rescore-progress.ts.
      if (wasAlreadyOnboarded) {
        const settings = await getSettings();
        // Presence, not truthiness. A failed count read leaves
        // scoredJobCount at 0, which onboardingRescoreOffer reads as "nothing
        // to rescore" — silently suppressing the offer exactly when the
        // database is flaky, right after this tenant's fit brain changed.
        // Offering anyway is the safer direction: a redundant offer costs one
        // dismissal, a wrongly suppressed one leaves the jobs table scored
        // against two different careers with nothing on screen saying so.
        if (settings.error !== undefined) {
          setRescoreReason(null);
          setRescoreUnknown(true);
          setRescoreCount(0);
          setRescoreDone(false);
          setRescoreNotice(null);
          setRescoreError(null);
          setStep("rescore");
          return;
        }
        const offer = onboardingRescoreOffer({
          scoredJobCount: settings.scoredJobCount,
          wasAlreadyOnboarded: true,
          dismissed: false,
        });
        if (offer) {
          setRescoreReason(offer);
          setRescoreUnknown(false);
          setRescoreCount(settings.scoredJobCount);
          setRescoreDone(false);
          setRescoreNotice(null);
          setRescoreError(null);
          setStep("rescore");
          return;
        }
      }
      setStep("done");
    } catch (err) {
      setErrors((e) => ({ ...e, finish: message(err) }));
    } finally {
      setBusy((b) => ({ ...b, finish: false }));
    }
  }

  async function handleRescoreNow() {
    setBusy((b) => ({ ...b, rescore: true }));
    setRescoring(true);
    setRescoreError(null);
    setRescoreNotice(null);
    try {
      const pass = await runRescorePass({
        // See UNKNOWN_RESCORE_BUDGET's own comment: this is a batch-count
        // CEILING, not the number of rows rescored, so an unknown count is
        // served by a generously large one rather than by 0 (which would cap
        // a real rescore at a single batch).
        total: rescoreUnknown ? UNKNOWN_RESCORE_BUDGET : rescoreCount,
        runBatch: (args) => rescoreAll(args),
        onProgress: (totals) => setRescoreNotice(rescoreSummary(totals)),
      });
      if (pass.error !== undefined) {
        setRescoreError(rescoreErrorText(pass.error));
        if (pass.rescored > 0 || pass.failed > 0) setRescoreNotice(rescoreSummary(pass));
      } else {
        setRescoreNotice(rescoreSummary(pass));
      }
      if (passDrained(pass)) {
        const stamp = await markCompScoringRescored(pass);
        // Presence, not truthiness — the repo's signature defect, copied
        // verbatim from components/Settings.tsx's own `if (stamp.error)`.
        // Fixed here; Settings.tsx is out of scope for this task and is
        // tracked separately.
        if (stamp.error !== undefined) {
          setRescoreNotice(
            (n) => `${n ?? ""} (${stamp.error} — this offer may reappear later.)`
          );
        }
      }
      setRescoreDone(true);
    } catch (err) {
      setRescoreError(`Rescore failed — ${message(err)}`);
    } finally {
      setRescoring(false);
      setBusy((b) => ({ ...b, rescore: false }));
    }
  }

  // ---- rendering ----

  // MUST come before the `step === "loading"` check below. On a failed load
  // (either the `state.error !== undefined` branch or the `catch` block in
  // the mount effect), `step` is never advanced off its initial "loading"
  // value — nothing in either failure path calls setStep. An error check
  // placed AFTER the loading guard is therefore unreachable: the spinner
  // returns first and never yields to it. (This was exactly wrong in an
  // earlier revision of this file — the loading guard came first, and the
  // error screen below it was genuinely dead code. Checked by re-reading this
  // exact sequence, not by re-asserting the fix works.)
  //
  // BLOCKS the whole wizard (Finding 1) rather than warning and continuing.
  // `answers` in this state is still DEFAULT_PROFILE's empty defaults — the
  // mount effect deliberately returns before applying the real read — so
  // there is nothing safe to show or edit, and no path from here reaches
  // saveProfile. States both facts settingsReadWarning states for the
  // equivalent /settings case: what is on screen is NOT the tenant's saved
  // data, and reload is the way out.
  // Presence (`!== null`), not truthiness — both producers (describeWriteFailure
  // in the state.error branch, the "Could not load onboarding — " template in
  // the catch block) are guaranteed non-empty today, but this is the same
  // presence-vs-truthiness doctrine every other check in this file follows,
  // and there is no reason for this one string to be the exception.
  if (loadError !== null) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-10">
        <h1 className="font-heading text-2xl font-semibold text-ink">Welcome</h1>
        <div className="mt-4 rounded-md border border-[#92400E]/30 bg-[#92400E]/5 p-3 text-sm text-[#92400E]">
          Could not load your saved answers — {loadError}. What you would see below is NOT
          your saved data, and continuing risks overwriting anything you already saved, so
          this page will not go further until it can read them. Reload to try again.
        </div>
      </div>
    );
  }

  if (step === "loading") {
    return (
      <div className="mx-auto max-w-2xl py-16">
        <Spinner label="Loading" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl py-8 sm:py-12">
      <h1 ref={headingRef} tabIndex={-1} className="font-heading text-3xl font-semibold tracking-tight text-ink outline-none">{step === "done" ? "Your search is ready" : "Let’s build your search"}</h1>
      <p className="mt-3 text-base text-ink/60">{step === "done" ? "Your profile is saved. Choose where to begin." : "A few details about you. A search that knows what matters."}</p>
      {step !== "done" && step !== "rescore" && <ol aria-label="Setup progress" className="mt-8 grid grid-cols-4 gap-2 text-xs sm:text-sm">
        {["Background", "Preferences", "Connect AI", "Review"].map((label, i) => <li key={label} aria-current={i === stepIndex ? "step" : undefined} className={`border-t-2 pt-3 ${i <= stepIndex ? "border-ink font-medium text-ink" : "border-slate text-ink/50"}`}>{label}</li>)}
      </ol>}

      {step === "key" && (
        <section className="mt-8">
          <h2 className="font-heading text-lg font-semibold">
            Connect your AI account
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-ink/60">{keyStepCopy()}</p>
          <ApiKeyPanel compact isAdmin={isAdmin} onReady={setKeyReady} onStatusChange={setConnectedKey} />

          {errors.key !== undefined && <p role="alert" className="mt-3 text-sm text-[#92400E]">{errors.key}</p>}
          <div className="mt-4 flex items-center gap-4">
            <button className="text-sm underline" onClick={() => setStep("preferences")}>Back</button>
            <button
              disabled={(!keyReady && !isAdmin) || !!busy.key}
              onClick={() => void handleKeyContinue()}
              className="rounded-md border border-ink bg-ink px-4 py-2 text-sm font-medium text-white transition hover:bg-ink/90"
            >
              Continue
            </button>
          </div>
        </section>
      )}

      {step === "door" && (
        <section className="mt-8">
          <h2 className="font-heading text-lg font-semibold">
            Start with your experience
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-ink/60">
            Upload or paste your résumé, or answer a few short questions.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <button
              onClick={() => chooseMode("questions")}
              className="rounded-lg border border-slate bg-white p-4 text-left transition hover:border-ink"
            >
              <div className="font-heading font-semibold">Answer a few questions</div>
              <p className="mt-1 text-sm text-ink/60">
                What you do now, what you want next, and where you'll work.
              </p>
            </button>
            <button
              onClick={() => chooseMode("resume")}
              className="rounded-lg border border-slate bg-white p-4 text-left transition hover:border-ink"
            >
              <div className="font-heading font-semibold">Use my résumé</div>
              <p className="mt-1 text-sm text-ink/60">
                Faster if you have one handy. We'll still ask what you want next.
              </p>
            </button>
          </div>
        </section>
      )}

      {step === "answers" && (
        <section className="mt-8">
          <h2 className="font-heading text-lg font-semibold">
            Your background: {" "}
            {answers.mode === "resume" ? "your résumé" : "a few questions"}
          </h2>

          {answers.mode === "resume" ? (
            <>
              <p className="mt-2 max-w-2xl text-sm text-ink/60">
                Uploaded files are read on this server to extract text; the original file is not stored.
                Review the text below before continuing. Your answers are saved when you continue
                from preferences and sent to your selected AI provider when you generate your profile.
              </p>
              <Field label="Upload your résumé" help="PDF, DOCX, or TXT. Up to 1 MB; PDF up to 10 pages. You can also paste below.">
                <input type="file" accept=".pdf,.docx,.txt" disabled={uploading} onChange={e => { void handleUpload(e.target.files?.[0]); e.target.value = ""; }} className="block w-full text-sm file:mr-4 file:rounded-lg file:border-0 file:bg-ink file:px-4 file:py-2 file:text-white" />
              </Field>
              {uploading && <p role="status" className="mt-2 text-sm">Reading your résumé…</p>}
              {uploadError !== null && <p role="alert" className="mt-2 text-sm text-[#92400E]">{uploadError}</p>}
              <Field label="Your résumé text" help="Check the imported text or paste your résumé here.">
                <textarea
                  value={answers.resume}
                  onChange={(e) => setAnswers((a) => ({ ...a, resume: e.target.value }))}
                  rows={12}
                  className="w-full rounded-md border border-slate px-3 py-2 text-sm"
                  placeholder="Paste your résumé here"
                />
              </Field>
              <button
                onClick={() => void handleClearAnswers()}
                disabled={uploading || !!busy.answers}
                className="mt-1 text-xs text-ink/40 underline transition hover:text-ink disabled:opacity-50"
              >
                Clear saved answers
              </button>
            </>
          ) : (
            <Field label="What do you do now?">
              <textarea
                value={answers.current}
                onChange={(e) => setAnswers((a) => ({ ...a, current: e.target.value }))}
                rows={3}
                className="w-full rounded-md border border-slate px-3 py-2 text-sm"
              />
            </Field>
          )}

          <div className="mt-6 flex items-center gap-4">
            <button onClick={() => setStep("door")} className="text-sm underline">Back</button>
            <button disabled={uploading || !(answers.mode === "resume" ? answers.resume : answers.current).trim()} onClick={() => setStep("preferences")} className="rounded-lg bg-ink px-5 py-3 text-sm font-medium text-white disabled:opacity-40">Continue to preferences</button>
          </div>
        </section>
      )}
      {step === "preferences" && (
        <section className="mt-8">
          <h2 className="font-heading text-xl font-semibold">What would make your next role a good move?</h2>
          <Field label="What do you want next?">
            <textarea
              value={answers.wanted}
              onChange={(e) => setAnswers((a) => ({ ...a, wanted: e.target.value }))}
              rows={3}
              className="w-full rounded-md border border-slate px-3 py-2 text-sm"
            />
          </Field>

          <Field label="Where will you work?">
            <textarea
              value={answers.where}
              onChange={(e) => setAnswers((a) => ({ ...a, where: e.target.value }))}
              rows={2}
              className="w-full rounded-md border border-slate px-3 py-2 text-sm"
              placeholder="Cities, remote, willing to relocate…"
            />
          </Field>

          <Field label="Minimum annual base salary (USD, optional)" help="Use a whole dollar amount, before bonus or equity. Leave blank for no minimum. A salary band must extend above this amount to clear your floor.">
            <input type="number" min="1" step="1" value={compFloor} onChange={e => setCompFloor(e.target.value)} placeholder="e.g. 120000" className="w-full rounded-md border border-slate px-3 py-2 text-sm" />
          </Field>
          <Field label="What rules a job out for you? (optional)">
            <textarea
              value={answers.dealbreakers}
              onChange={(e) => setAnswers((a) => ({ ...a, dealbreakers: e.target.value }))}
              rows={2}
              className="w-full rounded-md border border-slate px-3 py-2 text-sm"
              placeholder="Leave blank if nothing rules a job out"
            />
          </Field>

          {errors.answers && <p className="mt-2 text-sm text-[#92400E]">{errors.answers}</p>}

          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={() => setStep("answers")}
              disabled={!!busy.answers}
              className="text-sm text-ink/40 transition hover:text-ink disabled:opacity-50"
            >
              Back
            </button>
            <button
              onClick={() => void handleContinueFromAnswers()}
              disabled={!!busy.answers}
              className="rounded-md border border-ink bg-ink px-4 py-2 text-sm font-medium text-white transition hover:bg-ink/90 disabled:opacity-50"
            >
              {busy.answers ? "Saving…" : "Continue"}
            </button>
          </div>
        </section>
      )}

      {step === "generating" && (
        <section className="mt-8">
          <h2 className="font-heading text-lg font-semibold">
            Build your search profile
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-ink/60">
            Your answers become a search profile you can review and edit. Generating it uses
            your connected AI account and incurs an API charge. No job search starts yet.
          </p>

          {cappedMessage && (
            <div className="mt-4 rounded-md border border-ink/20 bg-ink/5 p-4">
              <p className="text-sm text-ink">{cappedMessage}</p>
              <div className="mt-3">
                <ApiKeyPanel compact isAdmin={isAdmin} onReady={setKeyReady} onStatusChange={setConnectedKey} />
              </div>
            </div>
          )}

          {errors.generate && !cappedMessage && (
            <p className="mt-3 text-sm text-[#92400E]">{errors.generate}</p>
          )}

          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={() => setStep("preferences")}
              disabled={!!busy.generate}
              className="text-sm text-ink/40 transition hover:text-ink disabled:opacity-50"
            >
              Back
            </button>
            <button
              onClick={() => void handleGenerate()}
              disabled={!!busy.generate}
              className="rounded-md border border-ink bg-ink px-4 py-2 text-sm font-medium text-white transition hover:bg-ink/90 disabled:opacity-50"
            >
              {busy.generate ? <Spinner label="Generating…" /> : "Generate my profile"}
            </button>
          </div>
        </section>
      )}

      {step === "review" && draft && (
        <section className="mt-8">
          <h2 className="font-heading text-lg font-semibold">
            Does this sound like you?
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-ink/60">
            Edit anything that is wrong before finishing. Your answers are saved. Your search profile takes effect when you finish.
          </p>

          <dl className="mt-6 divide-y divide-slate rounded-xl border border-slate bg-white px-5">
            {[["Roles we’ll look for", toList(draft.titles).join(", ")], ["Where you’ll work", draft.locationRule], ["Minimum base salary", compFloor.trim() ? `$${Number(compFloor).toLocaleString("en-US")} USD` : "No minimum"], ["What makes a strong match", draft.fitBrain]].map(([label, value]) => <div key={label} className="py-5"><dt className="font-heading font-semibold">{label}</dt><dd className="mt-2 whitespace-pre-line text-sm leading-relaxed text-ink/70">{value}</dd></div>)}
          </dl>
          <Field label="Minimum annual base salary (USD, optional)">
            <input type="number" min="1" step="1" value={compFloor} onChange={e => setCompFloor(e.target.value)} className="w-full rounded-md border border-slate px-3 py-2 text-sm" />
          </Field>
          <details className="mt-5 rounded-lg border border-slate bg-white p-5">
            <summary className="cursor-pointer font-medium">Edit your search profile</summary>
          <Field label="Job titles to search for" help="One per line.">
            <textarea
              value={draft.titles}
              onChange={(e) => updateDraft("titles", e.target.value)}
              rows={8}
              className="w-full rounded-md border border-slate px-3 py-2 text-sm"
            />
          </Field>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <Field label="Where" help="One location term per line.">
                <textarea
                  value={draft.locations}
                  onChange={(e) => updateDraft("locations", e.target.value)}
                  rows={4}
                  className="w-full rounded-md border border-slate px-3 py-2 text-sm"
                />
              </Field>
              <Field label="Location rule">
                <textarea
                  value={draft.locationRule}
                  onChange={(e) => updateDraft("locationRule", e.target.value)}
                  rows={3}
                  className="w-full rounded-md border border-slate px-3 py-2 text-sm"
                />
              </Field>
            </div>
            <div>
              <Field label="Tools of the trade" help="One per line.">
                <textarea
                  value={draft.stackTerms}
                  onChange={(e) => updateDraft("stackTerms", e.target.value)}
                  rows={8}
                  className="w-full rounded-md border border-slate px-3 py-2 text-sm"
                />
              </Field>
            </div>
          </div>

          {/* THIS IS WHAT SCORES YOUR ROLES — visually distinct from the search
              terms above on purpose. A wrong search term shows up as visibly
              missing results; a wrong scoring field looks exactly like a
              correct one, so it gets its own heading and its own border. */}
          <div className="mt-6 rounded-lg border-2 border-ink bg-ink/5 p-4">
            <h3 className="font-heading font-semibold uppercase tracking-wide text-ink">
              What makes a strong match
            </h3>
            <p className="mt-1 text-sm text-ink/60">
              Roles are scored against this description. Edit it to reflect your experience and priorities.
            </p>

            <Field label="Your background and priorities" help="A description of you. Required.">
              <textarea
                value={draft.fitBrain}
                onChange={(e) => updateDraft("fitBrain", e.target.value)}
                rows={12}
                className="w-full rounded-md border border-slate px-3 py-2 text-sm"
              />
            </Field>
            {!draft.fitBrain.trim() && (
              <p className="mt-1 text-sm text-[#92400E]">
                This cannot be empty — every role would be scored against nothing.
              </p>
            )}

            <Field label="Title scope" help="How seniority reads in this field. Optional.">
              <textarea
                value={draft.titleScope}
                onChange={(e) => updateDraft("titleScope", e.target.value)}
                rows={5}
                className="w-full rounded-md border border-slate px-3 py-2 text-sm"
              />
            </Field>

            <div className="mt-4 rounded-md border border-slate bg-white p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="text-sm font-semibold text-ink">Sample score</h4>
                <button
                  onClick={() => void handleSampleScore()}
                  disabled={!!busy.sample || !draft.fitBrain.trim()}
                  className="rounded-md border border-ink px-3 py-1.5 text-xs font-medium text-ink transition hover:bg-ink hover:text-white disabled:opacity-40"
                >
                  {busy.sample ? "Scoring…" : "Try a sample score"}
                </button>
              </div>
              <p className="mt-1 text-xs text-ink/60">
                Scores a sample posting built from your own titles against the fields above —
                one small billed call — so you can see how this actually scores before it runs
                on real postings.
              </p>
              {sampleError && <p className="mt-2 text-sm text-[#92400E]">{sampleError}</p>}
              {sampleResult && (
                <div className="mt-2 rounded-md border border-slate bg-ink/5 p-2 text-sm">
                  <div className="font-medium text-ink">
                    “{sampleResult.roleTitle}” scored {sampleResult.score}/5
                  </div>
                  <p className="mt-1 text-ink/70">{sampleResult.rationale}</p>
                </div>
              )}
            </div>
          </div>

          </details>

          <details
            className="mt-6 rounded-lg border border-slate bg-white p-4"
            open={showMore}
            onToggle={(e) => setShowMore((e.target as HTMLDetailsElement).open)}
          >
            <summary className="cursor-pointer font-heading font-semibold">
              Advanced search and scoring settings
            </summary>

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <TextField
                label="Search subject"
                value={draft.searchSubject}
                onChange={(v) => updateDraft("searchSubject", v)}
              />
              <TextField
                label="Query subject"
                value={draft.querySubject}
                onChange={(v) => updateDraft("querySubject", v)}
              />
              <TextField
                label="Candidate persona"
                value={draft.candidatePersona}
                onChange={(v) => updateDraft("candidatePersona", v)}
              />
              <TextField
                label="Building concept"
                value={draft.buildingConcept}
                onChange={(v) => updateDraft("buildingConcept", v)}
              />
              <TextField
                label="Building upside"
                value={draft.buildingUpside}
                onChange={(v) => updateDraft("buildingUpside", v)}
              />
              <label className="flex items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={draft.toolsAreWeak}
                  onChange={(e) => updateDraft("toolsAreWeak", e.target.checked)}
                />
                Tool-based search would return mostly noise for this field
              </label>
            </div>

            <Field label="Stack family intro">
              <textarea
                value={draft.stackFamilyIntro}
                onChange={(e) => updateDraft("stackFamilyIntro", e.target.value)}
                rows={3}
                className="w-full rounded-md border border-slate px-3 py-2 text-sm"
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-3">
              <Field label='Completes "2 = Weak fit — "'>
                <textarea
                  value={draft.weakFitTail}
                  onChange={(e) => updateDraft("weakFitTail", e.target.value)}
                  rows={3}
                  className="w-full rounded-md border border-slate px-3 py-2 text-sm"
                />
              </Field>
              <Field label='Completes "3 = Moderate fit — "'>
                <textarea
                  value={draft.moderateTail}
                  onChange={(e) => updateDraft("moderateTail", e.target.value)}
                  rows={3}
                  className="w-full rounded-md border border-slate px-3 py-2 text-sm"
                />
              </Field>
              <Field label='Completes "4 = Strong fit — "'>
                <textarea
                  value={draft.strongTail}
                  onChange={(e) => updateDraft("strongTail", e.target.value)}
                  rows={3}
                  className="w-full rounded-md border border-slate px-3 py-2 text-sm"
                />
              </Field>
            </div>

            <Field label="Domain bonus" help="An optional bonus scoring rule. May be blank.">
              <textarea
                value={draft.domainBonus}
                onChange={(e) => updateDraft("domainBonus", e.target.value)}
                rows={4}
                className="w-full rounded-md border border-slate px-3 py-2 text-sm"
              />
            </Field>

            <div className="mt-4 rounded-md border border-slate p-3">
              <h4 className="text-sm font-semibold text-ink">Hiring signal</h4>
              <p className="mt-1 text-xs text-ink/60">
                The public event or property the Discover tab watches for in this field.
              </p>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <TextField
                  label="Name"
                  value={draft.hiringSignalName}
                  onChange={(v) => updateDraft("hiringSignalName", v)}
                />
                <TextField
                  label="Qualifier"
                  value={draft.hiringSignalQualifier}
                  onChange={(v) => updateDraft("hiringSignalQualifier", v)}
                />
                <TextField
                  label="Exclusions"
                  value={draft.hiringSignalExclusions}
                  onChange={(v) => updateDraft("hiringSignalExclusions", v)}
                />
              </div>
              <Field label="Sources" help="One per line.">
                <textarea
                  value={draft.hiringSignalSources}
                  onChange={(e) => updateDraft("hiringSignalSources", e.target.value)}
                  rows={4}
                  className="w-full rounded-md border border-slate px-3 py-2 text-sm"
                />
              </Field>
              <Field label="Extra fields to extract" help="One snake_case field name per line.">
                <textarea
                  value={draft.hiringSignalExtraFields}
                  onChange={(e) => updateDraft("hiringSignalExtraFields", e.target.value)}
                  rows={3}
                  className="w-full rounded-md border border-slate px-3 py-2 text-sm"
                />
              </Field>
              <label className="flex items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={draft.hiringSignalHasRecency}
                  onChange={(e) => updateDraft("hiringSignalHasRecency", e.target.checked)}
                />
                This is a dated event, not a standing property of the employer
              </label>
            </div>
          </details>

          {errors.finish && <p className="mt-4 text-sm text-[#92400E]">{errors.finish}</p>}

          <div className="mt-6 flex flex-wrap items-center gap-4">
            <div>
              <button
                onClick={handleStartOver}
                disabled={!!busy.finish}
                className="text-sm text-ink/40 underline transition hover:text-ink disabled:opacity-50"
              >
                Start over
              </button>
              <p className="text-xs text-ink/40">
                Return to your answers. Generating a replacement profile incurs another API charge.
              </p>
            </div>
            <button
              onClick={() => void handleFinish()}
              disabled={!!busy.finish || !draft.fitBrain.trim()}
              className="rounded-md border border-ink bg-ink px-4 py-2 text-sm font-medium text-white transition hover:bg-ink/90 disabled:opacity-50"
            >
              {busy.finish ? "Saving…" : "Save my search profile"}
            </button>
          </div>
        </section>
      )}

      {step === "done" && <section className="mt-8 space-y-4">
        <Link href="/discover?mode=role" className="block rounded-xl bg-ink p-6 text-white"><h2 className="font-heading text-xl font-semibold">Find my first roles</h2><p className="mt-2 text-sm text-white/80">Choose a search based on your target titles. Review the estimate before starting.</p></Link>
        <Link href="/roles?add=1" className="block rounded-xl border border-slate bg-white p-6"><h2 className="font-heading text-xl font-semibold">Check a job I already found</h2><p className="mt-2 text-sm text-ink/70">Paste a posting URL to save it and see how it matches you. This uses your AI account.</p></Link>
        <p className="text-sm text-ink/60">No searches have started. You can change your preferences anytime in Settings.</p>
      </section>}

      {step === "rescore" && (rescoreReason !== null || rescoreUnknown) && (
        <section className="mt-8">
          <h2 className="font-heading text-lg font-semibold">Your existing pipeline</h2>
          <p className="mt-2 max-w-2xl text-sm text-ink/70">
            {rescoreReason !== null
              ? rescorePromptQuestion(rescoreReason, rescoreCount, { provider: isSupportedProvider(connectedKey?.provider ?? "") ? connectedKey?.provider as "anthropic" | "openai" | "google" : undefined, model: connectedKey?.model ?? undefined })
              : "Your profile just changed, but this app could not confirm how many " +
                "of your existing roles are already scored. Rescoring now keeps your " +
                "pipeline scored consistently against your new profile rather than " +
                "half against your old one."}
          </p>

          {rescoring && (
            <div className="mt-3">
              <Spinner label="Rescoring — one call per role, in batches." />
            </div>
          )}
          {rescoreError && <p className="mt-2 text-sm text-[#92400E]">Rescore: {rescoreError}</p>}
          {rescoreNotice && <p className="mt-2 text-sm text-ink/50">{rescoreNotice}</p>}

          <div className="mt-4 flex flex-wrap items-center gap-3">
            {!rescoreDone && (
              <>
                <button
                  onClick={() => void handleRescoreNow()}
                  disabled={rescoring}
                  className="rounded-md border border-ink bg-ink px-4 py-2 text-sm font-medium text-white transition hover:bg-ink/90 disabled:opacity-50"
                >
                  Rescore now
                </button>
                <button
                  onClick={() => router.push("/discover")}
                  disabled={rescoring}
                  className="text-sm text-ink/40 transition hover:text-ink disabled:opacity-50"
                >
                  Skip for now
                </button>
              </>
            )}
            {rescoreDone && (
              <button
                onClick={() => router.push("/discover")}
                className="rounded-md border border-ink bg-ink px-4 py-2 text-sm font-medium text-white transition hover:bg-ink/90"
              >
                Continue to Discover
              </button>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

function Field({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: React.ReactNode;
}) {
  const id = useId();
  return (
    <div className="mt-4">
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-ink">{label}</label>
      {help && <p className="mb-1 text-xs text-ink/50">{help}</p>}
      {React.isValidElement(children) ? React.cloneElement(children as React.ReactElement<{ id?: string }>, { id }) : children}
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-ink">{label}</label>
      <input
        id={id}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-slate px-3 py-2 text-sm"
      />
    </div>
  );
}
