// The per-tenant career profile: everything the prompts used to hardcode.
//
// NO import that transitively reaches `pg`. This module is imported by
// "use client" components (components/Onboarding.tsx, components/Settings.tsx),
// and lib/search-criteria.ts pulls in lib/settings-store.ts -> lib/supabase.ts.
// lib/fit-prompt.ts and lib/fit-inputs.ts are safe: they import only types and
// each other. Same hazard documented at lib/job-statuses.ts.
//
// NO Tailwind class strings either, for the reason lib/job-statuses.ts gives:
// tailwind.config.ts scans ./app/** and ./components/** only.

import type { FitInputs } from "@/lib/fit-inputs";
import {
  DEFAULT_DOMAIN_BONUS,
  DEFAULT_MODERATE_TAIL,
  DEFAULT_STRONG_TAIL,
  DEFAULT_TITLE_SCOPE,
  DEFAULT_WEAK_FIT_TAIL,
} from "@/lib/fit-prompt";

/**
 * The raw onboarding input, kept so generation can be re-run without asking
 * the user to re-type or re-paste. See the privacy note in
 * app/actions/onboarding.ts: this is the most sensitive thing the app stores,
 * it is never logged, and the user can clear it.
 */
export interface OnboardingAnswers {
  mode: "questions" | "resume";
  /** What they do now. Empty on the résumé path. */
  current: string;
  /** What they want next. Asked on BOTH paths — a résumé says where you have
   *  been, not where you are going. */
  wanted: string;
  where: string;
  dealbreakers: string;
  /** The pasted résumé. Empty on the questions path. */
  resume: string;
}

/**
 * The public event that predicts hiring in this field.
 *
 * Funding is ONE instance. The Discover tab's job is to find employers before
 * the job is posted; for a defence engineer the event is a contract award, for
 * a nurse it may be a standing property rather than an event at all — which is
 * what `hasRecency` answers (see lib/discovery-windows.ts and the "current"
 * DateRange member).
 */
export interface HiringSignal {
  name: string;
  sources: string[];
  qualifier: string;
  /**
   * What is BELOW the bar, named outright — the complement of `qualifier`.
   *
   * Two fields rather than one because a floor and an exclusion do different
   * work in the prompt and the old hardcoded funding prompt carried both:
   * "Focus exclusively on Series B and above" told the model where to aim,
   * and "Exclude seed, pre-seed, and Series A rounds" told it what to throw
   * away. The genericising pass kept only the first, and the exclusion was
   * lost with nothing replacing it — a documented behaviour change that
   * widened the result set. This is the field that carries it back.
   *
   * NOT folded into `qualifier`: that value is also spliced into the example
   * SEARCH QUERIES, where a long exclusion clause would turn a billed web
   * search into a garbage query string. `qualifier` has to stay short to
   * serve both call sites; this one is prompt-only.
   *
   * "" is a real value, for a signal where nothing needs ruling out.
   */
  exclusions: string;
  /** True when the signal is an EVENT, so time windows mean something. */
  hasRecency: boolean;
  /** Extra per-row fields worth asking the model for, beyond the fixed core. */
  extraFields: string[];
}

export interface Profile {
  answers: OnboardingAnswers;

  // --- scoring (reaches lib/fit-prompt.ts through profileToFitInputs) ---
  fitBrain: string;
  weakFitTail: string;
  moderateTail: string;
  strongTail: string;
  titleScope: string;
  domainBonus: string;

  // --- search and extraction ---
  /**
   * The field named in PROSE, four words in today's default. Splices into
   * roleSearchSystem() and the company-search sentence.
   *
   * Distinct from querySubject on purpose, and this is phase 1's ruling rather
   * than a preference: "split per grammatical form; never force one constant
   * through several".
   */
  searchSubject: string;
  /** The field named inside a SEARCH QUERY, two words in today's default. A
   *  query is not a sentence; the longer phrase makes the query worse. */
  querySubject: string;
  /** The stack family's whole intro SENTENCE, not just its subject — it names
   *  example job titles that are exactly as career-specific as the subject. */
  stackFamilyIntro: string;
  /** How the extraction schema describes the candidate, in fit_signal's field
   *  description. Not a label: it reaches the scorer as `Summary:`. */
  candidatePersona: string;
  /** ic_flag's positive gerund form. */
  buildingConcept: string;
  /** ic_flag's compressed negative compound-adjective form. NOT derivable from
   *  buildingConcept by substitution — see af8bd83. */
  buildingUpside: string;

  // --- discovery ---
  hiringSignal: HiringSignal;
  /** True when tool-based search is not worth running for this field, so the
   *  stack family is hidden rather than sending queries that match nothing. */
  toolsAreWeak: boolean;
}

/**
 * The guideline every stored text field is truncated at.
 *
 * Same number and same reason as FIT_BRAIN_MAX_CHARS in
 * lib/criteria-validation.ts: the brain is pasted into EVERY scoreFit call and
 * again into every row of a rescore, so a 15k-character brain generated from a
 * five-page CV is a permanent tax. Enforced here rather than advised, because
 * this text arrives from a model rather than from a person watching a warning.
 */
export const PROFILE_TEXT_MAX_CHARS = 4000;

const DEFAULT_ANSWERS: OnboardingAnswers = {
  mode: "questions",
  current: "",
  wanted: "",
  where: "",
  dealbreakers: "",
  resume: "",
};

/**
 * The shipped profile, which must be a NO-OP against the pre-onboarding app.
 *
 * Every value below is today's hardcoded text VERBATIM — the same technique
 * DEFAULT_STATUSES used. That is what makes Tasks 4 and 5 a shape change
 * rather than a behaviour change, and it is what the three fit-prompt fixtures
 * prove.
 *
 * `fitBrain` is the ONE exception and is deliberately empty: with real tenants,
 * a working career fallback means any gap in the gate scores a stranger's roles
 * against someone else's background. Silent wrongness is the failure mode this
 * codebase consistently chooses to fail loudly on instead — see
 * emptySearchReason in lib/search-criteria.ts.
 */
export const DEFAULT_PROFILE: Profile = {
  answers: DEFAULT_ANSWERS,

  fitBrain: "",
  weakFitTail: DEFAULT_WEAK_FIT_TAIL,
  moderateTail: DEFAULT_MODERATE_TAIL,
  strongTail: DEFAULT_STRONG_TAIL,
  titleScope: DEFAULT_TITLE_SCOPE,
  domainBonus: DEFAULT_DOMAIN_BONUS,

  searchSubject: "go-to-market and revenue operations",
  querySubject: "revenue operations",
  stackFamilyIntro:
    "Search job boards and company careers pages for currently-open go-to-market / revenue operations roles that mention these tools. Titles vary — include Business Systems Manager, Growth Systems Lead, Revenue Systems, and similar, not just the obvious RevOps titles. Use these searches",
  candidatePersona:
    "GTM Systems / RevOps / Marketing Ops leader and AI practitioner-builder",
  buildingConcept: "building GTM systems and agentic AI workflows",
  buildingUpside: "systems/AI-building upside",

  hiringSignal: {
    name: "funding rounds",
    // discover.ts states its sources TWICE and the two lists differ: the
    // system prompt names ten, the user prompt eight. This field renders
    // both, so it carries the superset — see Ruling 3 in the SDD ledger. Do
    // not trim this to the user prompt's eight; that list cannot reproduce
    // the system prompt.
    sources: [
      "TechCrunch",
      "Crunchbase",
      "The Information",
      "Bloomberg",
      "Forbes",
      "VentureBeat",
      "Reuters",
      "WSJ",
      "Business Insider",
      "X/Twitter",
    ],
    qualifier: "Series B and above",
    // Verbatim from the pre-genericisation hardcoded Discover system prompt:
    // "Exclude seed, pre-seed, and Series A rounds."
    exclusions: "seed, pre-seed, and Series A rounds",
    hasRecency: true,
    extraFields: ["raised", "stage", "lead_investor", "founded", "traction", "category"],
  },
  toolsAreWeak: false,
};

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

const clip = (s: string): string =>
  s.length > PROFILE_TEXT_MAX_CHARS ? s.slice(0, PROFILE_TEXT_MAX_CHARS) : s;

/** A field that must not be empty: blank or wrong-typed falls back. */
const text = (v: unknown, fallback: string): string => {
  const s = str(v);
  return s && s.trim() ? clip(s) : fallback;
};

/** A field where "" is a real value (domainBonus omits its whole block). */
const optionalText = (v: unknown, fallback: string): string => {
  const s = str(v);
  return s === null ? fallback : clip(s);
};

/**
 * A list of strings, with non-string members DROPPED rather than coerced.
 *
 * `String(x)` on an object renders "[object Object]" straight into a search
 * query. Prose where a list belongs falls back to the default entirely: a
 * one-element list holding a paragraph is worse than the shipped list.
 */
const list = (v: unknown, fallback: string[]): string[] => {
  if (!Array.isArray(v)) return [...fallback];
  const out = v.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  return out.length > 0 ? out.map((s) => s.trim()) : [...fallback];
};

function resolveAnswers(raw: unknown): OnboardingAnswers {
  const a = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    mode: a.mode === "resume" ? "resume" : "questions",
    current: optionalText(a.current, ""),
    wanted: optionalText(a.wanted, ""),
    where: optionalText(a.where, ""),
    dealbreakers: optionalText(a.dealbreakers, ""),
    resume: optionalText(a.resume, ""),
  };
}

function resolveHiringSignal(raw: unknown): HiringSignal {
  const h = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_PROFILE.hiringSignal;
  return {
    name: text(h.name, d.name),
    sources: list(h.sources, d.sources),
    qualifier: optionalText(h.qualifier, d.qualifier),
    // optionalText, not text: "" is a real answer for a signal where nothing
    // needs ruling out, exactly as it is for qualifier.
    exclusions: optionalText(h.exclusions, d.exclusions),
    // A non-boolean reads as the default rather than as `true`: windows that
    // mean nothing are a worse default than windows that are missing.
    hasRecency: typeof h.hasRecency === "boolean" ? h.hasRecency : d.hasRecency,
    extraFields: list(h.extraFields, d.extraFields),
  };
}

/**
 * Turns whatever is in the jsonb row into a profile the prompts can run on.
 *
 * REPAIRS rather than rejects, in the shape of resolveStatuses
 * (lib/job-statuses.ts). A model that returns prose where a list was asked for
 * must not produce a fit brain that is the word "undefined".
 *
 * CRITICAL: returns fresh objects and fresh arrays, never a reference into
 * DEFAULT_PROFILE. Callers can mutate the result without corrupting the
 * module-level fallback for the life of the process — the same rule
 * mergeSettings' copy loop enforces in lib/settings-store.ts, and the one shape
 * that loop does NOT handle is an object, which is why this is spelled out.
 *
 * A repaired profile is USED, never written back: the write happens only when
 * the user finishes onboarding or saves on /settings.
 */
export function resolveProfile(raw: unknown): Profile {
  const p = (typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? raw
    : {}) as Record<string, unknown>;
  const d = DEFAULT_PROFILE;
  return {
    answers: resolveAnswers(p.answers),

    // Empty, never a career. See the note on DEFAULT_PROFILE.fitBrain.
    fitBrain: optionalText(p.fitBrain, ""),
    // Contractually non-empty — an empty tail renders "2 = Weak fit — " with a
    // trailing space, which the doubled-blank-line guard cannot see.
    weakFitTail: text(p.weakFitTail, d.weakFitTail),
    moderateTail: text(p.moderateTail, d.moderateTail),
    strongTail: text(p.strongTail, d.strongTail),
    // "" omits the whole block, heading included (titleScopeBlock /
    // domainBonusBlock), so empty is a VALUE here rather than a missing field.
    titleScope: optionalText(p.titleScope, d.titleScope),
    domainBonus: optionalText(p.domainBonus, d.domainBonus),

    searchSubject: text(p.searchSubject, d.searchSubject),
    querySubject: text(p.querySubject, d.querySubject),
    stackFamilyIntro: text(p.stackFamilyIntro, d.stackFamilyIntro),
    candidatePersona: text(p.candidatePersona, d.candidatePersona),
    buildingConcept: text(p.buildingConcept, d.buildingConcept),
    buildingUpside: text(p.buildingUpside, d.buildingUpside),

    hiringSignal: resolveHiringSignal(p.hiringSignal),
    toolsAreWeak: p.toolsAreWeak === true,
  };
}

/**
 * The scoring half of the profile, in the shape scoreFit takes.
 *
 * compFloor comes in separately because it is NOT a profile field — it is its
 * own numeric setting with its own editor and its own reset, and folding it in
 * would make a floor change look like a profile edit.
 */
export function profileToFitInputs(
  profile: Profile,
  compFloor: number | null
): FitInputs {
  return {
    fitBrain: profile.fitBrain,
    compFloor,
    weakFitTail: profile.weakFitTail,
    moderateTail: profile.moderateTail,
    strongTail: profile.strongTail,
    titleScope: profile.titleScope,
    domainBonus: profile.domainBonus,
  };
}
