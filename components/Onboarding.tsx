"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import {
  clearAnswers,
  generateProfile,
  getOnboardingState,
  saveAnswers,
  saveProfile,
} from "@/app/actions/onboarding";
import { getApiKeyStatus } from "@/app/actions/api-key";
import { scoreFit } from "@/app/actions/parse-role";
import { getSettings, markCompScoringRescored, rescoreAll } from "@/app/actions/settings";

// Type-only imports. lib/profile.ts and lib/onboarding-rules.ts are safe to
// pull in at RUNTIME too (see their own header comments — neither reaches
// `pg`), which is what makes DEFAULT_PROFILE, profileToFitInputs, and
// sampleRoleFor usable as real values below rather than just types.
import {
  DEFAULT_PROFILE,
  profileToFitInputs,
  type HiringSignal,
  type OnboardingAnswers,
  type Profile,
} from "@/lib/profile";
import type { GeneratedProfile } from "@/lib/onboarding-prompt";
import { answersAreComplete, sampleRoleFor } from "@/lib/onboarding-rules";
import { needsKeyMessage } from "@/lib/budget";
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

// The five steps of the brief, plus the housekeeping states around them.
// "loading" and "rescore" are not numbered in the spec but are real screens:
// "loading" covers the two reads that decide where step 0 starts, and
// "rescore" is the re-run offer Task 8's review added on top of Step 4.
type Step = "loading" | "key" | "door" | "answers" | "generating" | "review" | "rescore";

type Section = "key" | "answers" | "generate" | "sample" | "finish" | "rescore";

/** The editable form of a generated profile — every list joined to lines, so
 *  each field binds to one textarea the way titles/locations/stackTerms do on
 *  /settings. Reshaping only: nothing here decides anything, which is why it
 *  stays a plain mapping in the component rather than moving to lib/. */
interface ProfileDraft {
  fitBrain: string;
  weakFitTail: string;
  moderateTail: string;
  strongTail: string;
  titleScope: string;
  domainBonus: string;
  searchSubject: string;
  querySubject: string;
  stackFamilyIntro: string;
  candidatePersona: string;
  buildingConcept: string;
  buildingUpside: string;
  hiringSignalName: string;
  hiringSignalSources: string;
  hiringSignalQualifier: string;
  hiringSignalHasRecency: boolean;
  hiringSignalExtraFields: string;
  toolsAreWeak: boolean;
  titles: string;
  locations: string;
  stackTerms: string;
  locationRule: string;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Textarea lines to a list — trimmed, blanks dropped. The server normalizes
 *  again (validateList, inside saveProfile), so this only has to be good
 *  enough to preview and to send; it does not have to be the final word. */
const toList = (text: string) =>
  text
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

function draftFromGenerated(g: GeneratedProfile): ProfileDraft {
  return {
    fitBrain: g.fitBrain,
    weakFitTail: g.weakFitTail,
    moderateTail: g.moderateTail,
    strongTail: g.strongTail,
    titleScope: g.titleScope,
    domainBonus: g.domainBonus,
    searchSubject: g.searchSubject,
    querySubject: g.querySubject,
    stackFamilyIntro: g.stackFamilyIntro,
    candidatePersona: g.candidatePersona,
    buildingConcept: g.buildingConcept,
    buildingUpside: g.buildingUpside,
    hiringSignalName: g.hiringSignal.name,
    hiringSignalSources: g.hiringSignal.sources.join("\n"),
    hiringSignalQualifier: g.hiringSignal.qualifier,
    hiringSignalHasRecency: g.hiringSignal.hasRecency,
    hiringSignalExtraFields: g.hiringSignal.extraFields.join("\n"),
    toolsAreWeak: g.toolsAreWeak,
    titles: g.titles.join("\n"),
    locations: g.locations.join("\n"),
    stackTerms: g.stackTerms.join("\n"),
    locationRule: g.locationRule,
  };
}

/** The draft, in the shape both saveProfile and scoreFit need. Structurally a
 *  `Profile & GeneratedProfile` — saveProfile's own required type — AND
 *  assignable to plain `Profile` for profileToFitInputs, since it is a
 *  superset. `answers` comes from the caller's own state, never spread from
 *  the generated object: GeneratedProfile omits it on purpose (Task 8's
 *  review), so spreading only the draft would overwrite the user's stored
 *  answers and résumé with nothing. */
function payloadFrom(draft: ProfileDraft, answers: OnboardingAnswers): Profile & GeneratedProfile {
  const hiringSignal: HiringSignal = {
    name: draft.hiringSignalName,
    sources: toList(draft.hiringSignalSources),
    qualifier: draft.hiringSignalQualifier,
    hasRecency: draft.hiringSignalHasRecency,
    extraFields: toList(draft.hiringSignalExtraFields),
  };
  return {
    answers,
    fitBrain: draft.fitBrain,
    weakFitTail: draft.weakFitTail,
    moderateTail: draft.moderateTail,
    strongTail: draft.strongTail,
    titleScope: draft.titleScope,
    domainBonus: draft.domainBonus,
    searchSubject: draft.searchSubject,
    querySubject: draft.querySubject,
    stackFamilyIntro: draft.stackFamilyIntro,
    candidatePersona: draft.candidatePersona,
    buildingConcept: draft.buildingConcept,
    buildingUpside: draft.buildingUpside,
    hiringSignal,
    toolsAreWeak: draft.toolsAreWeak,
    titles: toList(draft.titles),
    locations: toList(draft.locations),
    stackTerms: toList(draft.stackTerms),
    locationRule: draft.locationRule,
  };
}

export default function Onboarding() {
  const router = useRouter();

  const [step, setStep] = useState<Step>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);

  const [answers, setAnswers] = useState<OnboardingAnswers>(DEFAULT_PROFILE.answers);
  // Read once, at mount, before this run can have changed it. A first run has
  // nothing to rescore — see onboardingRescoreOffer in lib/rescore-progress.ts.
  const [wasAlreadyOnboarded, setWasAlreadyOnboarded] = useState(false);

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
        // Presence, not truthiness — the message can be empty.
        if (state.error !== undefined) setLoadError(state.error);
        setAnswers(state.answers);
        setWasAlreadyOnboarded(
          state.onboardedAt !== null && state.onboardedAt.length > 0
        );
        // A failed key check is treated the same as "no key": Step 0 still
        // shows, and ApiKeyPanel surfaces the read failure itself when it
        // loads a second time.
        setStep(keyStatus.error === undefined && keyStatus.present ? "door" : "key");
      } catch (err) {
        if (!cancelled) setLoadError(`Could not load onboarding — ${message(err)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleKeyContinue() {
    setBusy((b) => ({ ...b, key: true }));
    setErrors((e) => ({ ...e, key: undefined }));
    try {
      const status = await getApiKeyStatus();
      if (status.error !== undefined) {
        setErrors((e) => ({ ...e, key: status.error }));
        return;
      }
      if (!status.present) {
        setErrors((e) => ({ ...e, key: "Add and save a key above before continuing." }));
        return;
      }
      setStep("door");
    } catch (err) {
      setErrors((e) => ({ ...e, key: message(err) }));
    } finally {
      setBusy((b) => ({ ...b, key: false }));
    }
  }

  function chooseMode(mode: OnboardingAnswers["mode"]) {
    setAnswers((a) => ({ ...a, mode }));
    setStep("answers");
  }

  async function handleContinueFromAnswers() {
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
      setStep("generating");
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
      const fitInputs = profileToFitInputs(payloadFrom(draft, answers), null);
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
      const res = await saveProfile(payloadFrom(draft, answers));
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
        const offer = onboardingRescoreOffer({
          scoredJobCount: settings.scoredJobCount,
          wasAlreadyOnboarded: true,
          dismissed: false,
        });
        if (offer) {
          setRescoreReason(offer);
          setRescoreCount(settings.scoredJobCount);
          setRescoreDone(false);
          setRescoreNotice(null);
          setRescoreError(null);
          setStep("rescore");
          return;
        }
      }
      router.push("/discover");
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
        total: rescoreCount,
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
        if (stamp.error) {
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

  if (step === "loading") {
    return (
      <div className="mx-auto max-w-2xl py-16">
        <Spinner label="Loading" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="font-heading text-2xl font-semibold text-ink">Welcome</h1>
      <p className="mt-1 text-sm text-ink/60">
        A few questions decide what this tool searches for and how it scores what it finds.
      </p>

      {loadError && (
        <div className="mt-4 rounded-md border border-[#92400E]/30 bg-[#92400E]/5 p-3 text-sm text-[#92400E]">
          {loadError}
        </div>
      )}

      {step === "key" && (
        <section className="mt-8">
          <h2 className="font-heading text-lg font-semibold">Step 1 of 4 — your API key</h2>
          <p className="mt-1 max-w-2xl text-sm text-ink/60">
            This app runs entirely on your own model API key — nothing you do here bills
            anyone but you, and there is no free tier to fall back on.
          </p>
          <ApiKeyPanel />
          {errors.key && <p className="mt-3 text-sm text-[#92400E]">{errors.key}</p>}
          <div className="mt-4">
            <button
              onClick={() => void handleKeyContinue()}
              disabled={!!busy.key}
              className="rounded-md border border-ink bg-ink px-4 py-2 text-sm font-medium text-white transition hover:bg-ink/90 disabled:opacity-50"
            >
              {busy.key ? "Checking…" : "Continue"}
            </button>
          </div>
        </section>
      )}

      {step === "door" && (
        <section className="mt-8">
          <h2 className="font-heading text-lg font-semibold">Step 2 of 4 — tell us about you</h2>
          <p className="mt-1 max-w-2xl text-sm text-ink/60">
            Answer a few short questions, or paste a résumé and tell us what you want next.
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
              <div className="font-heading font-semibold">Paste a résumé</div>
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
            Step 2 of 4 — {answers.mode === "resume" ? "your résumé" : "a few questions"}
          </h2>

          {answers.mode === "resume" ? (
            <>
              <p className="mt-2 max-w-2xl text-sm text-ink/60">
                Your résumé is sent to your own model provider, on your own API key. It is
                stored so you can regenerate your profile later without pasting it again, and
                you can clear it at any time.
              </p>
              <Field label="Your résumé">
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
                disabled={!!busy.answers}
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
              onClick={() => setStep("door")}
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
          <h2 className="font-heading text-lg font-semibold">Step 3 of 4 — build your profile</h2>
          <p className="mt-1 max-w-2xl text-sm text-ink/60">
            One billed call to your model provider turns your answers into search terms and a
            scoring rubric. You can edit everything it produces on the next screen.
          </p>

          {cappedMessage && (
            <div className="mt-4 rounded-md border border-ink/20 bg-ink/5 p-4">
              <p className="text-sm text-ink">{cappedMessage}</p>
              <div className="mt-3">
                <ApiKeyPanel />
              </div>
            </div>
          )}

          {errors.generate && !cappedMessage && (
            <p className="mt-3 text-sm text-[#92400E]">{errors.generate}</p>
          )}

          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={() => setStep("answers")}
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
          <h2 className="font-heading text-lg font-semibold">Step 4 of 4 — review</h2>
          <p className="mt-1 max-w-2xl text-sm text-ink/60">
            Edit anything that is wrong before finishing. Nothing is saved until you click
            Finish.
          </p>

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
              This is what scores your roles
            </h3>
            <p className="mt-1 text-sm text-ink/60">
              Every posting you see is scored 1–5 against this. Get this wrong and every score
              is wrong, silently.
            </p>

            <Field label="Fit brain" help="A description of you. Required.">
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

          <details
            className="mt-6 rounded-lg border border-slate bg-white p-4"
            open={showMore}
            onToggle={(e) => setShowMore((e.target as HTMLDetailsElement).open)}
          >
            <summary className="cursor-pointer font-heading font-semibold">
              More — generated fields most people never need to touch
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
                Re-runs generation from Step 2 — this bills your API key again.
              </p>
            </div>
            <button
              onClick={() => void handleFinish()}
              disabled={!!busy.finish || !draft.fitBrain.trim()}
              className="rounded-md border border-ink bg-ink px-4 py-2 text-sm font-medium text-white transition hover:bg-ink/90 disabled:opacity-50"
            >
              {busy.finish ? "Saving…" : "Looks right — finish"}
            </button>
          </div>
        </section>
      )}

      {step === "rescore" && rescoreReason !== null && (
        <section className="mt-8">
          <h2 className="font-heading text-lg font-semibold">Your existing pipeline</h2>
          <p className="mt-2 max-w-2xl text-sm text-ink/70">
            {rescorePromptQuestion(rescoreReason, rescoreCount)}
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
  return (
    <div className="mt-4">
      <label className="mb-1 block text-sm font-medium text-ink">{label}</label>
      {help && <p className="mb-1 text-xs text-ink/50">{help}</p>}
      {children}
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
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-ink">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-slate px-3 py-2 text-sm"
      />
    </div>
  );
}
