"use client";

import { useEffect, useState } from "react";
import {
  countCrawlJobsMatchingTitles,
  getSettings,
  markCompScoringRescored,
  rescoreAll,
  resetSetting,
  saveCeiling,
  saveCompFloor,
  saveCriteriaList,
  saveCriteriaText,
} from "@/app/actions/settings";
// Type-only, so nothing from lib/settings-store (and therefore nothing from
// `pg`) is pulled into the client bundle — the import is erased at compile.
import type { SettingsView } from "@/lib/settings-view";
import { estimateRunCost, formatEstimate, type EstimateInput } from "@/lib/cost-estimate";
import {
  FIT_BRAIN_MAX_CHARS,
  normalizeList,
  validateText,
} from "@/lib/criteria-validation";
import { removedTitles, removedTitlesWarning } from "@/lib/removed-titles";
import {
  passDrained,
  rescoreErrorText,
  rescoreOffers,
  rescoreSummary,
  runRescorePass,
} from "@/lib/rescore-progress";
import RescorePrompt from "./RescorePrompt";
import { Spinner } from "./ui";
import ApiKeyPanel from "./ApiKeyPanel";

// Setting keys are written as literals rather than imported from
// lib/settings-store.ts on purpose: that module imports lib/supabase, which
// would drag `pg` into the client bundle. The literals are still checked —
// saveCriteriaList takes a ListSettingKey and saveCriteriaText a
// TextSettingKey, so a wrong or misspelled key is a compile error here.

type ListSection = "titles" | "locations" | "stackTerms";
type TextSection = "locationRule" | "fitBrain";
type Section = ListSection | TextSection | "ceiling" | "compFloor";

/** The two cards that can offer a rescore, and therefore own its progress. */
type RescoreOwner = Extract<Section, "fitBrain" | "compFloor">;

const LABELS: Record<Section, string> = {
  titles: "Target titles",
  locations: "Location terms",
  stackTerms: "GTM stack terms",
  locationRule: "Location rule",
  fitBrain: "Fit brain",
  ceiling: "Search ceiling",
  compFloor: "Minimum base compensation",
};

/**
 * The location rule has no length guideline — only the fit brain does (it is
 * pasted into every scoreFit call, once per role scored). Passing Infinity
 * uses validateText for its empty check alone; `length > Infinity` is never
 * true, so this section can never warn.
 */
const NO_LENGTH_GUIDELINE = Number.POSITIVE_INFINITY;

interface Draft {
  titles: string;
  locations: string;
  stackTerms: string;
  locationRule: string;
  fitBrain: string;
  ceilingEnabled: boolean;
  ceiling: string;
  compFloorEnabled: boolean;
  compFloor: string;
}

const EMPTY_DRAFT: Draft = {
  titles: "",
  locations: "",
  stackTerms: "",
  locationRule: "",
  fitBrain: "",
  ceilingEnabled: false,
  ceiling: "",
  compFloorEnabled: false,
  compFloor: "",
};

function draftFrom(view: SettingsView): Draft {
  return {
    titles: view.criteria.titles.join("\n"),
    locations: view.criteria.locations.join("\n"),
    stackTerms: view.criteria.stackTerms.join("\n"),
    locationRule: view.criteria.locationRule,
    fitBrain: view.criteria.fitBrain,
    ceilingEnabled: view.ceiling !== null,
    ceiling: view.ceiling === null ? "" : String(view.ceiling),
    compFloorEnabled: view.compFloor !== null,
    compFloor: view.compFloor === null ? "" : String(view.compFloor),
  };
}

/**
 * Re-syncs ONE section's draft from freshly-read settings.
 *
 * Not the whole draft: the five sections save independently, and rebuilding
 * every field after one save would silently discard edits the user has typed
 * into the other four but not yet saved.
 */
function syncSection(draft: Draft, view: SettingsView, section: Section): Draft {
  const fresh = draftFrom(view);
  switch (section) {
    case "titles":
      return { ...draft, titles: fresh.titles };
    case "locations":
      return { ...draft, locations: fresh.locations };
    case "stackTerms":
      return { ...draft, stackTerms: fresh.stackTerms };
    case "locationRule":
      return { ...draft, locationRule: fresh.locationRule };
    case "fitBrain":
      return { ...draft, fitBrain: fresh.fitBrain };
    case "ceiling":
      return { ...draft, ceilingEnabled: fresh.ceilingEnabled, ceiling: fresh.ceiling };
    case "compFloor":
      return {
        ...draft,
        compFloorEnabled: fresh.compFloorEnabled,
        compFloor: fresh.compFloor,
      };
  }
}

/** Textarea lines to a criteria list, normalized the same way the server will. */
const toList = (text: string) => normalizeList(text.split("\n"));

/**
 * Separator for packing the removed-title list into a single effect key.
 * A newline is safe because normalizeList collapses every whitespace run to a
 * single space, so no normalized title can contain one.
 */
const SEP = "\n";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * A positive whole number, or null for "off". Shared by the search ceiling
 * and the comp floor — both reject 0 and non-integers the same way
 * saveCeiling and saveCompFloor do server-side.
 */
function parsePositiveInt(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

export default function Settings() {
  const [view, setView] = useState<SettingsView | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [busy, setBusy] = useState<Partial<Record<Section, boolean>>>({});
  const [errors, setErrors] = useState<Partial<Record<Section, string>>>({});
  const [notices, setNotices] = useState<Partial<Record<Section, string>>>({});

  const [removedCount, setRemovedCount] = useState<number | null>(null);
  const [removedCountError, setRemovedCountError] = useState<string | null>(null);

  const [rescoring, setRescoring] = useState(false);
  const [rescoreDismissed, setRescoreDismissed] = useState(false);
  // Set by a fit-brain SAVE as well as a reset. It widens the gate (see
  // fitBrainRescoreOffer) — never required for the prompt to appear, so it
  // cannot bury it on a fresh load — and it is also what entitles the prompt
  // to open with "Saved.". Before it covered saves, a bare page load with a
  // stored brain rendered that word with nothing behind it.
  const [fitBrainTouchedHere, setFitBrainTouchedHere] = useState(false);
  // Same idea for the comp floor. The server half of ITS gate is
  // view.compScoringRescoredAt (see compRescoreOffer), so this flag only ever
  // WIDENS that gate — covering a floor edit made after a pass was already
  // stamped — and picks the prompt's wording. It is never required for the
  // prompt to appear, so it cannot bury the day-one offer on a fresh load.
  const [compFloorTouchedHere, setCompFloorTouchedHere] = useState(false);
  const [rescoreNotice, setRescoreNotice] = useState<string | null>(null);
  const [rescoreError, setRescoreError] = useState<string | null>(null);
  // Which card's Rescore button started the pass. There are two prompts and ONE
  // pass, so its spinner, error and summary have to belong to exactly one card:
  // rendered unconditionally in the fit-brain card and again under
  // `!offers.fitBrain` in the compensation card, they both fired on the day-one
  // path (shipped fit brain → no fit-brain offer → the compensation prompt is
  // the only one on screen) and the user saw everything twice, once in a card
  // showing no prompt at all. Owner-keyed rather than offer-keyed because the
  // offers vanish the moment a drained pass sets `rescoreDismissed` — a guard
  // written on `offers` moves the finished summary to the other card, or drops
  // it, at the exact moment it becomes worth reading.
  const [rescoreOwner, setRescoreOwner] = useState<RescoreOwner | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const fresh = await getSettings();
        if (cancelled) return;
        setView(fresh);
        setDraft(draftFrom(fresh));
        setLoadError(fresh.error ?? null);
      } catch (err) {
        if (!cancelled) setLoadError(`Could not load settings — ${message(err)}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const savedTitles = view?.criteria.titles ?? [];
  const removed = removedTitles(savedTitles, toList(draft.titles));
  // Keyed as a string rather than an array so the effect below re-runs when
  // the SET of removed titles changes, not on every keystroke that leaves it
  // the same. SEP is a newline, which a normalized title cannot contain — a
  // space separator would tear multi-word titles apart on the way back out.
  const removedKey = removed.join(SEP);

  useEffect(() => {
    if (!removedKey) {
      setRemovedCount(null);
      setRemovedCountError(null);
      return;
    }
    let cancelled = false;
    setRemovedCount(null);
    setRemovedCountError(null);
    // Debounced: this runs while the user types in the titles box.
    const timer = setTimeout(async () => {
      try {
        const res = await countCrawlJobsMatchingTitles(removedKey.split(SEP));
        if (cancelled) return;
        if (res.error) setRemovedCountError(res.error);
        else setRemovedCount(res.count);
      } catch (err) {
        if (!cancelled) {
          setRemovedCountError(`Could not count matching roles — ${message(err)}`);
        }
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [removedKey]);

  /** Re-reads settings. Never throws — a failed reload must not read as a failed save. */
  async function refresh(section?: Section) {
    try {
      const fresh = await getSettings();
      setView(fresh);
      if (section) setDraft((d) => syncSection(d, fresh, section));
      setLoadError(fresh.error ?? null);
    } catch (err) {
      setLoadError(`Could not reload settings — ${message(err)}`);
    }
  }

  function fail(section: Section, text: string) {
    setErrors((e) => ({ ...e, [section]: text }));
    setNotices((n) => ({ ...n, [section]: undefined }));
  }

  /**
   * Runs one section's server action.
   *
   * try/catch/finally is not optional here: this repo has already shipped a
   * button left permanently disabled by a rejected promise, with no error
   * anywhere. `finally` clears the busy flag whatever happens.
   *
   * On failure the draft is left EXACTLY as typed — syncSection only runs on
   * success — so a save that fails does not throw away the user's edit.
   */
  async function run(
    section: Section,
    action: () => Promise<{ error?: string }>,
    after?: () => void
  ) {
    setBusy((b) => ({ ...b, [section]: true }));
    setErrors((e) => ({ ...e, [section]: undefined }));
    setNotices((n) => ({ ...n, [section]: undefined }));
    try {
      const res = await action();
      if (res.error) {
        setErrors((e) => ({ ...e, [section]: res.error }));
        return;
      }
      setNotices((n) => ({ ...n, [section]: "Saved." }));
      await refresh(section);
      after?.();
    } catch (err) {
      setErrors((e) => ({ ...e, [section]: `Save failed — ${message(err)}` }));
    } finally {
      setBusy((b) => ({ ...b, [section]: false }));
    }
  }

  function handleSaveList(key: ListSection) {
    void run(key, () => saveCriteriaList(key, LABELS[key], toList(draft[key])));
  }

  function handleSaveText(key: TextSection) {
    const maxChars = key === "fitBrain" ? FIT_BRAIN_MAX_CHARS : NO_LENGTH_GUIDELINE;
    const check = validateText(draft[key], LABELS[key], maxChars);
    if (check.error) {
      fail(key, check.error);
      return;
    }
    // The warning is rendered continuously below the field and deliberately
    // does not block the save.
    void run(
      key,
      () => saveCriteriaText(key, LABELS[key], draft[key]),
      // A fit-brain edit makes every existing score stale. Un-dismiss so the
      // prompt reappears even if it was waved off earlier in this session, and
      // mark it touched — that flag is what lets the prompt say "Saved.", which
      // is true here and is not true on a bare page load.
      key === "fitBrain"
        ? () => {
            setFitBrainTouchedHere(true);
            setRescoreDismissed(false);
          }
        : undefined
    );
  }

  function handleReset(section: Exclude<Section, "ceiling">) {
    void run(
      section,
      () => resetSetting(section),
      // Reverting to the shipped fit brain makes existing scores just as stale
      // as editing it does — but it also DELETES the app_settings row, so
      // getSettings reports fitBrainOverridden: false and the server-side gate
      // below stops firing. This session flag covers that one case.
      section === "fitBrain"
        ? () => {
            setFitBrainTouchedHere(true);
            setRescoreDismissed(false);
          }
        : undefined
    );
  }

  function handleSaveCeiling() {
    if (!draft.ceilingEnabled) {
      void run("ceiling", () => saveCeiling(null));
      return;
    }
    const n = parsePositiveInt(draft.ceiling);
    if (n === null) {
      fail(
        "ceiling",
        "Enter a whole number of searches (at least 1), or turn the ceiling off."
      );
      return;
    }
    void run("ceiling", () => saveCeiling(n));
  }

  /**
   * A comp-floor save (on OR off) is a scoring-input edit exactly like a
   * fit-brain edit — see saveCompFloor's doc comment — so both branches touch
   * the rescore gate, not just the "set a number" branch.
   */
  function handleSaveCompFloor() {
    const afterSave = () => {
      setCompFloorTouchedHere(true);
      setRescoreDismissed(false);
    };
    if (!draft.compFloorEnabled) {
      void run("compFloor", () => saveCompFloor(null), afterSave);
      return;
    }
    const n = parsePositiveInt(draft.compFloor);
    if (n === null) {
      fail(
        "compFloor",
        "Enter a whole dollar amount (at least 1), or turn the minimum off."
      );
      return;
    }
    void run("compFloor", () => saveCompFloor(n), afterSave);
  }

  /**
   * Drives rescoreAll's batches from the client.
   *
   * The loop itself lives in runRescorePass (lib/rescore-progress.ts) rather
   * than here, because its load-bearing rule — take the pass timestamp ONCE
   * and thread it into every batch — is only observable across batches, and a
   * loop written inline in a React component cannot be tested in this repo.
   * Out there it is pinned by a simulated multi-batch pass.
   */
  async function handleRescore(owner: RescoreOwner) {
    const total = view?.scoredJobCount ?? 0;
    setRescoreOwner(owner);
    setRescoring(true);
    setRescoreError(null);
    setRescoreNotice(null);

    try {
      const pass = await runRescorePass({
        total,
        // passStartedAt is undefined on the first batch (the server mints it)
        // and is the first batch's value on every one after; limit shrinks to
        // whatever is actually left, so the tail batch buys no repeat work.
        runBatch: (args) => rescoreAll(args),
        // Progress after every batch, so a long pass is not a silent one.
        onProgress: (totals) => setRescoreNotice(rescoreSummary(totals)),
      });

      // Presence, not truthiness, and rescoreErrorText for the display half —
      // the same doctrine runRescorePass now follows. `if (pass.error)` sent an
      // empty-message failure down the SUCCESS branch, rendering a clean
      // summary for a pass that had failed.
      if (pass.error !== undefined) {
        setRescoreError(rescoreErrorText(pass.error));
        // Partial work still happened; report it rather than losing the count.
        if (pass.rescored > 0 || pass.failed > 0) {
          setRescoreNotice(rescoreSummary(pass));
        }
      } else {
        setRescoreNotice(rescoreSummary(pass));
      }
      // Collapse the offer only when the pass actually finished. Rows left
      // over, rows that failed, or a remainder that could not be COUNTED keep
      // the prompt on screen so a second run is one click away — and a fresh
      // page load re-offers it either way.
      //
      // The SAME condition stamps the server-side suppression, for exactly
      // that reason: a partial, failed, or unverified pass must not be able to
      // switch the day-one offer off permanently. The rule is passDrained, out
      // in lib/rescore-progress.ts, so that "an uncounted remainder is not
      // zero" is pinned by a test rather than by this expression.
      //
      // Stamped whatever put the prompt on screen. One pass re-scores every
      // scored row through the same scoreFit, compensation included, so a
      // fit-brain rescore satisfies the compensation offer just as fully as a
      // comp-floor one does; suppressing only "its own" trigger would bill a
      // second identical pass for nothing.
      if (passDrained(pass)) {
        setRescoreDismissed(true);
        // The pass goes with it: the action re-applies passDrained itself, so
        // a future edit that moves this call out of the branch refuses rather
        // than stamping a partial pass.
        const stamp = await markCompScoringRescored(pass);
        if (stamp.error) {
          // The rescore itself succeeded and must not be reported as failed;
          // only the record of it is missing, and the visible cost of that is
          // the offer coming back on the next load.
          setRescoreNotice(
            `${rescoreSummary(pass)} (${stamp.error} — this offer may reappear ` +
              `on your next visit.)`
          );
        }
      }
    } catch (err) {
      // runRescorePass captures a rejected batch as `error` rather than
      // throwing, so this is a belt-and-braces net around the state updates.
      setRescoreError(`Rescore failed — ${message(err)}`);
    } finally {
      setRescoring(false);
    }

    await refresh();
  }

  /**
   * The rescore spinner, error and summary — for the card that started the pass
   * and no other. One function, not the same three blocks pasted into both
   * cards: pasted, their guards drifted apart and the day-one path rendered
   * everything twice.
   */
  function rescoreProgress(owner: RescoreOwner) {
    if (rescoreOwner !== owner) return null;
    return (
      <>
        {rescoring && (
          <div className="mt-2">
            <Spinner label="Rescoring — one Claude call per role, in batches of 25." />
          </div>
        )}
        {/* Both, not either. A batch that failed part-way still rescored rows,
            and hiding that count behind the error would leave the user unable
            to tell how much of their pipeline is current. */}
        {rescoreError && (
          <p className="mt-2 text-sm text-[#92400E]">Rescore: {rescoreError}</p>
        )}
        {rescoreNotice && <p className="mt-2 text-sm text-ink/50">{rescoreNotice}</p>}
      </>
    );
  }

  const estimateInput: EstimateInput = {
    titles: toList(draft.titles).length,
    locations: toList(draft.locations).length,
    stackTerms: toList(draft.stackTerms).length,
    ceiling: draft.ceilingEnabled ? parsePositiveInt(draft.ceiling) : null,
  };
  const estimateLine = formatEstimate(estimateInput);

  const fitCheck = validateText(draft.fitBrain, LABELS.fitBrain, FIT_BRAIN_MAX_CHARS);

  // BOTH offers, decided out in lib/rescore-progress.ts — whether to show each
  // one and what each may claim. No gate expression and no wording literal
  // lives in this file: rules written here cannot be tested (this repo does not
  // unit-test React), and RescoreReason is branded precisely so a hardcoded
  // wording at either call site below is a compile error rather than a silent
  // revert to "Saved." on a page load where nothing was saved.
  //
  // `view` is passed WHOLE rather than field by field, so there is no per-field
  // wiring here to get wrong. `rescoreDismissed` is shared: dismissing either
  // prompt dismisses both, since one rescoreAll pass covers whatever went stale.
  const offers = view
    ? rescoreOffers(view, {
        fitBrainEditedThisSession: fitBrainTouchedHere,
        floorEditedThisSession: compFloorTouchedHere,
        dismissed: rescoreDismissed,
      })
    : { fitBrain: null, compensation: null };

  if (loading) {
    return <div className="py-12 text-center text-sm text-ink/40">Loading…</div>;
  }

  return (
    <div className="max-w-3xl">
      <div className="mb-6">
        <h2 className="text-xl font-heading font-semibold">Search criteria</h2>
        <p className="text-sm text-ink/60">
          What every search, crawl, and fit score is built from. Each section saves on
          its own. Leaving a section untouched keeps the shipped default.
        </p>
      </div>

      {loadError && (
        <div className="mb-4 rounded-md border border-[#92400E]/30 bg-[#92400E]/5 p-3 text-sm text-[#92400E]">
          {loadError}
        </div>
      )}

      <SectionCard
        label={LABELS.titles}
        help="One per line. Drives Find roles, the By Role search, and what the weekly crawler hunts for on every tracked company."
        error={errors.titles}
        notice={notices.titles}
      >
        <textarea
          value={draft.titles}
          onChange={(e) => setDraft((d) => ({ ...d, titles: e.target.value }))}
          rows={10}
          className="w-full rounded-md border border-slate px-3 py-2 text-sm"
        />
        <p className="mt-1 text-xs text-ink/40">{estimateLine} · approximate</p>

        {removed.length > 0 && (
          <div className="mt-2 rounded-md border border-[#92400E]/30 bg-[#92400E]/5 p-2 text-xs text-[#92400E]">
            {removedCountError ? (
              <span>{removedCountError}</span>
            ) : removedCount === null ? (
              <span>Checking how many tracked roles match the titles you are removing…</span>
            ) : (
              <span>{removedTitlesWarning(removedCount)}</span>
            )}
            <div className="mt-1 text-ink/50">
              Removing: {removed.join(", ")}
            </div>
          </div>
        )}

        <SectionActions
          busy={!!busy.titles}
          onSave={() => handleSaveList("titles")}
          onReset={() => handleReset("titles")}
        />
      </SectionCard>

      <SectionCard
        label={LABELS.locations}
        help="One per line. Each title and each stack term is searched once per location term, so this list multiplies the cost of a run."
        error={errors.locations}
        notice={notices.locations}
      >
        <textarea
          value={draft.locations}
          onChange={(e) => setDraft((d) => ({ ...d, locations: e.target.value }))}
          rows={4}
          className="w-full rounded-md border border-slate px-3 py-2 text-sm"
        />
        <p className="mt-1 text-xs text-ink/40">{estimateLine} · approximate</p>
        <SectionActions
          busy={!!busy.locations}
          onSave={() => handleSaveList("locations")}
          onReset={() => handleReset("locations")}
        />
      </SectionCard>

      <SectionCard
        label={LABELS.stackTerms}
        help="One per line. Catches roles whose titles are idiosyncratic — Business Systems Manager, Growth Systems Lead — by searching for the tools they run."
        error={errors.stackTerms}
        notice={notices.stackTerms}
      >
        <textarea
          value={draft.stackTerms}
          onChange={(e) => setDraft((d) => ({ ...d, stackTerms: e.target.value }))}
          rows={8}
          className="w-full rounded-md border border-slate px-3 py-2 text-sm"
        />
        <SectionActions
          busy={!!busy.stackTerms}
          onSave={() => handleSaveList("stackTerms")}
          onReset={() => handleReset("stackTerms")}
        />
      </SectionCard>

      <SectionCard
        label={LABELS.locationRule}
        help="Pasted verbatim into the role-search and crawl prompts. It decides which locations count as acceptable."
        error={errors.locationRule}
        notice={notices.locationRule}
      >
        <textarea
          value={draft.locationRule}
          onChange={(e) => setDraft((d) => ({ ...d, locationRule: e.target.value }))}
          rows={5}
          className="w-full rounded-md border border-slate px-3 py-2 text-sm"
        />
        <SectionActions
          busy={!!busy.locationRule}
          onSave={() => handleSaveText("locationRule")}
          onReset={() => handleReset("locationRule")}
        />
      </SectionCard>

      <SectionCard
        label={LABELS.fitBrain}
        help="The background every role is scored against, 1–5. Sent on every fit-scoring call."
        error={errors.fitBrain}
        notice={notices.fitBrain}
      >
        <textarea
          value={draft.fitBrain}
          onChange={(e) => setDraft((d) => ({ ...d, fitBrain: e.target.value }))}
          rows={16}
          className="w-full rounded-md border border-slate px-3 py-2 text-sm"
        />
        <p className="mt-1 text-xs text-ink/40">
          {draft.fitBrain.trim().length} characters · guideline {FIT_BRAIN_MAX_CHARS}
        </p>
        {fitCheck.warning && (
          <p className="mt-1 text-xs text-[#92400E]">{fitCheck.warning}</p>
        )}
        <SectionActions
          busy={!!busy.fitBrain}
          onSave={() => handleSaveText("fitBrain")}
          onReset={() => handleReset("fitBrain")}
        />

        {view && offers.fitBrain && (
          <RescorePrompt
            count={view.scoredJobCount}
            reason={offers.fitBrain}
            busy={rescoring}
            onRescore={() => void handleRescore("fitBrain")}
            onDismiss={() => setRescoreDismissed(true)}
          />
        )}
        {rescoreProgress("fitBrain")}
      </SectionCard>

      <SectionCard
        label={LABELS.compFloor}
        help="Filters the Roles table and feeds fit scoring. It never keeps a role from being saved — every posting the crawler and every search find still lands in your pipeline, floor or no floor."
        error={errors.compFloor}
        notice={notices.compFloor}
      >
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={!draft.compFloorEnabled}
              onChange={(e) =>
                setDraft((d) => ({ ...d, compFloorEnabled: !e.target.checked }))
              }
            />
            No minimum
          </label>
          <label className="flex items-center gap-2 text-sm">
            $
            <input
              type="number"
              min={1}
              step={1}
              value={draft.compFloor}
              disabled={!draft.compFloorEnabled}
              onChange={(e) => setDraft((d) => ({ ...d, compFloor: e.target.value }))}
              placeholder="150000"
              className="w-28 rounded-md border border-slate px-2 py-1 text-sm disabled:opacity-40"
            />
            base, minimum
          </label>
        </div>
        <SectionActions
          busy={!!busy.compFloor}
          onSave={handleSaveCompFloor}
          onReset={() =>
            void run("compFloor", () => saveCompFloor(null), () => {
              setCompFloorTouchedHere(true);
              setRescoreDismissed(false);
            })
          }
          resetLabel="Turn off"
        />

        {view && offers.compensation && (
          <RescorePrompt
            count={view.scoredJobCount}
            reason={offers.compensation}
            busy={rescoring}
            onRescore={() => void handleRescore("compFloor")}
            onDismiss={() => setRescoreDismissed(true)}
          />
        )}
        {rescoreProgress("compFloor")}
      </SectionCard>

      <SectionCard
        label={LABELS.ceiling}
        help="A runaway rail on a single By Role run, counted in web searches. Off by default — a run then issues one search per query."
        error={errors.ceiling}
        notice={notices.ceiling}
      >
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={!draft.ceilingEnabled}
              onChange={(e) =>
                setDraft((d) => ({ ...d, ceilingEnabled: !e.target.checked }))
              }
            />
            No ceiling
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="number"
              min={1}
              step={1}
              value={draft.ceiling}
              disabled={!draft.ceilingEnabled}
              onChange={(e) => setDraft((d) => ({ ...d, ceiling: e.target.value }))}
              placeholder="15"
              className="w-24 rounded-md border border-slate px-2 py-1 text-sm disabled:opacity-40"
            />
            searches per run
          </label>
          <span className="text-xs text-ink/40">
            ≈ ${estimateRunCost(estimateInput).dollars.toFixed(2)} per run at this
            setting
          </span>
        </div>
        <SectionActions
          busy={!!busy.ceiling}
          onSave={handleSaveCeiling}
          onReset={() => void run("ceiling", () => saveCeiling(null))}
          resetLabel="Turn off"
        />
      </SectionCard>
    </div>
  );
}

function SectionCard({
  label,
  help,
  error,
  notice,
  children,
}: {
  label: string;
  help: string;
  error?: string;
  notice?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-4 rounded-lg border border-slate bg-white p-4">
      <h3 className="font-heading font-semibold">{label}</h3>
      <p className="mb-2 text-sm text-ink/60">{help}</p>
      {children}
      {/* Named and local. One shared banner would let the next action's
          message wipe the report of the section that actually failed. */}
      {error && (
        <p className="mt-2 text-sm text-[#92400E]">
          {label}: {error}
        </p>
      )}
      {notice && !error && <p className="mt-2 text-sm text-ink/50">{notice}</p>}
    </section>
  );
}

function SectionActions({
  busy,
  onSave,
  onReset,
  resetLabel = "Reset to defaults",
}: {
  busy: boolean;
  onSave: () => void;
  onReset: () => void;
  resetLabel?: string;
}) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <button
        onClick={onSave}
        disabled={busy}
        className="rounded-md border border-ink bg-ink px-4 py-2 text-sm font-medium text-white transition hover:bg-ink/90 disabled:opacity-50"
      >
        {busy ? "Saving…" : "Save"}
      </button>
      <button
        onClick={onReset}
        disabled={busy}
        className="text-sm text-ink/40 transition hover:text-ink disabled:opacity-50"
      >
        {resetLabel}
      </button>
      <ApiKeyPanel />
</div>
  );
}
