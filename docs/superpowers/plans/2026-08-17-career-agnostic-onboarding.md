# Career-agnostic profiles and first-run onboarding — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every career-specific string in the app come from a per-tenant
profile written during a first-run onboarding flow, so a mechanical engineer
gets mechanical-engineering searches and scoring instead of Tom Keefe's.

**Architecture:** Phase 1 turned every career-specific prompt fragment into a
named constant or a `FitInputs` field. Phase 2 is the switch: one jsonb
`profile` row in `app_settings` (standalone, outside `SETTING_KEYS`, following
the documented `JOB_STATUSES_KEY` precedent) becomes the source for all of
them, written by a four-step onboarding flow at `/welcome` behind a page-level
redirect. `DEFAULT_PROFILE` ships today's GTM text verbatim, so the switch is a
shape change with no behavioural change; `DEFAULT_FIT_BRAIN` becomes `""` so an
un-onboarded tenant's search **refuses** rather than running on someone else's
career.

**Tech Stack:** Next.js 14 App Router, TypeScript, Tailwind, Postgres (`pg` via
`lib/supabase.ts`), Anthropic via `lib/model-call.ts`, vitest (`environment:
"node"`, `lib/**/*.test.ts` + `app/**/*.test.ts`).

**Spec:** `docs/superpowers/specs/2026-08-17-career-agnostic-onboarding-design.md`
(revision 3, approved). Phase 1's post-mortem —
`docs/superpowers/specs/2026-08-17-prompt-generalisation-noop-design.md`,
section "What this pass actually cost" — is binding on how this plan is
executed and is quoted where it applies.

---

## Global Constraints

- **Verification gate:** `npm run build && npm test` must both pass before any
  commit. `npm run lint` is non-functional in this repo — never add it.
- **861 tests are green at `bac5fb1`.** No task may reduce that count. Two
  tests must pass **UNEDITED**: `lib/settings-store.test.ts` (it asserts the
  three shape groups partition `SETTING_KEYS` exactly) and
  `lib/settings-effects.test.ts`. If either needs an edit, a key went into
  `SETTING_KEYS` that the standalone decision says must not.
- **The three fit-prompt fixtures must stay byte-identical** through every
  commit in this plan: `lib/__fixtures__/fit-prompt.no-floor.txt`,
  `.with-floor.txt`, `.empty-blocks.txt`. They are the no-op proof. **A commit
  that touches only a fixture is a red flag, not a routine refresh** — if one
  needs regenerating, the change altered what the model receives and is wrong.
- **The fit golden set is NOT re-run** as part of this work
  (`lib/fit-agreement.ts`, `lib/__fixtures__/fit-golden-set.json`). The fixture
  identity above is what stands in for it. If a fixture fails, stop: re-capturing
  the golden set is a different and larger decision.
- **Error contract** (`.claude/skills/swallowed-string-errors`): every action
  returns `{ error?: string }`, the string **can be empty**, detection is
  `describeWriteFailure(...)` then `!== undefined` — never truthiness. A
  failure that is NOT the database (Claude, JSON parsing) substitutes its own
  fallback at the catch, because `UNDESCRIBED_DB_ERROR` names the database and
  would be a false sentence there.
- **No new tables and no migration.** `app_settings` is key/value jsonb
  (`db/schema.sql:137`, `db/migrations/001_tenant_id.sql` added the composite
  key). `lib/supabase.test.ts` walks `db/` and would notice a stray file.
- **Line numbers in the spec are as of `7af185e` and are not maintained.**
  Re-derive every one before editing. A drifted line number is not a defect; a
  false claim about what the code says is. Quoted TEXT must be exact.
- **Treat every factual claim in a comment, a spec, or CLAUDE.md as an
  assertion requiring a grep.** Phase 1 produced twelve defects and every single
  one was prose asserting something about code, written without opening the
  file. The code was right every time.
- **Never construct an SDK client.** `lib/model-call.ts` is the only entry point
  (`callWithWebSearch`, `callStructured`, `complete`, `parseJson`).
- **Every Claude call is wrapped in `withBudget`** (`lib/metered.ts`). An
  unwrapped call bills the platform key uncapped and unrecorded — a defect this
  repo has already shipped once (`app/actions/parse-role.ts`).
- **No Tailwind arbitrary-value classes outside `app/**` and `components/**`.**
  `tailwind.config.ts` scans those two roots only; a class string in `lib/`
  renders unstyled through a green build. Pinned by `lib/job-statuses.test.ts`.
- **The onboarding prompt and the résumé must never be logged.** This codebase
  logs prompts and query lists liberally; these two are the exception.
- **Deploy is blocked until GitHub is back.** `main` is 38 commits ahead and
  production is running `railway up`-uploaded code that any Railway **variable
  change** silently reverts to `e8b6b1b`. Do not edit Railway variables. When
  GitHub returns, pushing `main` is the first action.

---

## Deviation from the spec, stated up front

The spec (written against `7af185e`, before phase 1 landed) says **"One
generated `fieldNoun` covers four of the five"** GTM prompt sites. Phase 1
proved that false and its ruling is binding: *"Split per grammatical form;
never force one constant through several."* The code at `bac5fb1` carries three
distinct field-subject constants, not one:

| Constant | Form | Where it splices |
|---|---|---|
| `SEARCH_SUBJECT` = `"go-to-market and revenue operations"` | four-word prose | `roleSearchSystem()`, the company-search sentence |
| `QUERY_SUBJECT` = `"revenue operations"` | two-word query term | `stackQueries()` — a query is not a sentence |
| `STACK_FAMILY_INTRO` | a whole sentence, subject in the SLASHED form plus three GTM job titles | the stack family's prompt intro |

Plus `CANDIDATE_PERSONA`, `BUILDING_CONCEPT` and `BUILDING_UPSIDE`, which are
three separate strings for the same reason (`BUILDING_UPSIDE` is a compressed
negative compound adjective that cannot be produced from `BUILDING_CONCEPT` by
substitution — `af8bd83` reverted an attempt).

**This plan therefore gives the profile seven generated text fields where the
spec named one.** That is not a redesign: it is the spec's intent carried onto
code that changed under it. Everything else in revision 3 is implemented as
written.

Second, smaller correction: the spec's Components table places `DateRange` in
`lib/types.ts`. It is declared at `app/actions/discover.ts:16` and imported by
`lib/discovery-windows.ts:1`. `Startup` **is** in `lib/types.ts:22`. Task 13
edits the file that actually holds each.

---

## File structure

**New, pure (testable, no `pg`, no Tailwind):**

| File | Responsibility |
|---|---|
| `lib/profile.ts` | The `Profile` type, `DEFAULT_PROFILE` (today's GTM text), `resolveProfile()` repair, `profileToFitInputs()` |
| `lib/profile.test.ts` | Repair rules, defaults, truncation |
| `lib/company-role-prompt.ts` | The one sentence `roles.ts` and `crawler.ts` share, verbatim |
| `lib/company-role-prompt.test.ts` | Byte-identity against today's rendering + the handed-value guard |
| `lib/role-search-prompt.ts` | The keyword role-search family intros and prompt body |
| `lib/role-search-prompt.test.ts` | Same two guarantees |
| `lib/onboarding-prompt.ts` | The generation prompt + the response schema it asks for |
| `lib/onboarding-prompt.test.ts` | Rendered fixtures, in the manner of the fit-prompt ones |
| `lib/career-neutrality.test.ts` | **The phase-2 guard.** Source scan: no career-specific constant is referenced outside its home module |
| `lib/hiring-signal-prompt.ts` | Discover's two prompts + result schema, built from `hiringSignal` |
| `lib/hiring-signal-prompt.test.ts` | Byte-identity for the venture default + the handed-value guard |

**New, impure:**

| File | Responsibility |
|---|---|
| `app/actions/onboarding.ts` | `saveAnswers`, `generateProfile` (metered), `saveProfile` (transactional), `getOnboardingState`, `clearAnswers` |
| `app/welcome/page.tsx` | The one page outside the gate |
| `components/Onboarding.tsx` | Steps 0–4, two entry doors |

**Modified:**

| File | Change |
|---|---|
| `lib/settings-store.ts` | `PROFILE_KEY`, `ONBOARDED_AT_KEY`, `profileFrom`, `writeProfile`, `onboardedAtFrom`, `readOnboardedAtFor(tenantId)`, `writeOnboardedAt`; both literals added to `upsertSetting`'s key union |
| `lib/search-criteria.ts` | `DEFAULT_FIT_BRAIN` → `""`; `scoringInputsFrom` sources `FitInputs` from the profile; loaders carry the profile; `stackQueries` takes the query subject; `emptySearchReason` gains a fit-brain arm |
| `lib/fit-prompt.ts` | **No change.** Phase 1 already parameterised every field and gated both blocks |
| `lib/crawler.ts` | `RunContext` carries the profile; both prompt tiers read it |
| `app/actions/roles.ts`, `app/actions/role-search.ts` | Prompts move to the new `lib/` builders; profile threaded in |
| `app/actions/parse-role.ts` | `scoreFit` refuses an empty fit brain before billing |
| `lib/require-actor.ts` | `requireActorPage()` redirects un-onboarded tenants; `requireAdminPage()` opts out |
| `app/admin/page.tsx` | Calls `requireAdminPage()` |
| `app/actions/discover.ts` | Both prompts and the result schema from `hiringSignal`; `DateRange` gains `"current"` |
| `lib/types.ts` | `Startup` gains `signal` and `extras` |
| `lib/discovery-windows.ts` | `"current"` handled |
| `components/Discover.tsx` | Windows only when `hasRecency`; cards render `signal` + extras |
| `components/Settings.tsx` | Edits the new profile fields; "GTM stack terms" → "Tools of the trade" |
| `components/Nav.tsx`, `app/layout.tsx`, `app/signin/page.tsx`, `app/gate/page.tsx` | Drop the previous user's name and the GTM framing |
| `CLAUDE.md` | Its opening sentence and three architecture paragraphs become wrong |

---

## Task 1: The profile shape and its repair function

**Files:**
- Create: `lib/profile.ts`
- Create: `lib/profile.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_WEAK_FIT_TAIL`, `DEFAULT_MODERATE_TAIL`, `DEFAULT_STRONG_TAIL`, `DEFAULT_TITLE_SCOPE`, `DEFAULT_DOMAIN_BONUS` from `@/lib/fit-prompt`; `FitInputs` from `@/lib/fit-inputs`.
- Produces:
  - `interface OnboardingAnswers { mode: "questions" | "resume"; current: string; wanted: string; where: string; dealbreakers: string; resume: string }`
  - `interface HiringSignal { name: string; sources: string[]; qualifier: string; hasRecency: boolean; extraFields: string[] }`
  - `interface Profile { answers: OnboardingAnswers; fitBrain: string; searchSubject: string; querySubject: string; stackFamilyIntro: string; candidatePersona: string; buildingConcept: string; buildingUpside: string; weakFitTail: string; moderateTail: string; strongTail: string; titleScope: string; domainBonus: string; hiringSignal: HiringSignal; toolsAreWeak: boolean }`
  - `const DEFAULT_PROFILE: Profile`
  - `function resolveProfile(raw: unknown): Profile`
  - `function profileToFitInputs(profile: Profile, compFloor: number | null): FitInputs`
  - `const PROFILE_TEXT_MAX_CHARS = 4000`

**Design notes for the implementer:**

`lib/profile.ts` must import **nothing** that transitively reaches `pg`. It is
imported by `components/Onboarding.tsx` and `components/Settings.tsx`, both
`"use client"`. `lib/fit-prompt.ts` and `lib/fit-inputs.ts` are safe (they
import only each other's types); `lib/search-criteria.ts` is **not** (it imports
`lib/settings-store.ts` → `lib/supabase.ts` → `pg`). So the seven
search/extraction defaults are re-declared as literals here rather than
imported from `search-criteria.ts`, and **Task 5 deletes them from
`search-criteria.ts` and re-exports them from here**, so there is exactly one
copy at the end of the plan. Do not leave two.

`resolveProfile` REPAIRS rather than rejects, in the shape of `resolveStatuses`
(`lib/job-statuses.ts:100`): a missing or wrong-typed field falls back to the
DEFAULT for that field, and every returned object is a fresh copy so a caller
cannot mutate the module-level fallback. Three fields differ from that rule and
each needs its own comment:

- `fitBrain` repairs to `""`, never to `DEFAULT_PROFILE.fitBrain`, because
  `DEFAULT_FIT_BRAIN` becomes `""` in Task 6 and a repair that substituted a
  career would reopen exactly the failure this project exists to close.
- `domainBonus` may legitimately be `""` — `domainBonusBlock` omits the whole
  block for it (`lib/fit-prompt.ts:167`). An empty string is therefore a value,
  not a missing field.
- `weakFitTail` / `moderateTail` / `strongTail` are **contractually non-empty**
  (`lib/fit-inputs.ts:40`): `2 = Weak fit — ` with a trailing space is invisible
  to the doubled-blank-line guard. Empty repairs to the default.

Every text field is truncated at `PROFILE_TEXT_MAX_CHARS`, matching
`FIT_BRAIN_MAX_CHARS = 4000` in `lib/criteria-validation.ts:56` and for the
same stated reason: the brain is paid on every `scoreFit` and again on every
rescore row.

- [ ] **Step 1: Write the failing test**

Create `lib/profile.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import {
  DEFAULT_PROFILE,
  PROFILE_TEXT_MAX_CHARS,
  profileToFitInputs,
  resolveProfile,
} from "./profile";
import {
  DEFAULT_DOMAIN_BONUS,
  DEFAULT_MODERATE_TAIL,
  DEFAULT_STRONG_TAIL,
  DEFAULT_TITLE_SCOPE,
  DEFAULT_WEAK_FIT_TAIL,
} from "./fit-prompt";

describe("DEFAULT_PROFILE", () => {
  test("carries today's shipped text, so the switch is a no-op", () => {
    expect(DEFAULT_PROFILE.searchSubject).toBe("go-to-market and revenue operations");
    expect(DEFAULT_PROFILE.querySubject).toBe("revenue operations");
    expect(DEFAULT_PROFILE.candidatePersona).toBe(
      "GTM Systems / RevOps / Marketing Ops leader and AI practitioner-builder"
    );
    expect(DEFAULT_PROFILE.buildingConcept).toBe("building GTM systems and agentic AI workflows");
    expect(DEFAULT_PROFILE.buildingUpside).toBe("systems/AI-building upside");
    expect(DEFAULT_PROFILE.weakFitTail).toBe(DEFAULT_WEAK_FIT_TAIL);
    expect(DEFAULT_PROFILE.moderateTail).toBe(DEFAULT_MODERATE_TAIL);
    expect(DEFAULT_PROFILE.strongTail).toBe(DEFAULT_STRONG_TAIL);
    expect(DEFAULT_PROFILE.titleScope).toBe(DEFAULT_TITLE_SCOPE);
    expect(DEFAULT_PROFILE.domainBonus).toBe(DEFAULT_DOMAIN_BONUS);
  });

  test("its fit brain is EMPTY — a career is never a fallback", () => {
    expect(DEFAULT_PROFILE.fitBrain).toBe("");
  });

  test("its hiring signal reproduces today's funding search", () => {
    expect(DEFAULT_PROFILE.hiringSignal.name).toBe("funding rounds");
    expect(DEFAULT_PROFILE.hiringSignal.qualifier).toBe("Series B and above");
    expect(DEFAULT_PROFILE.hiringSignal.hasRecency).toBe(true);
    expect(DEFAULT_PROFILE.hiringSignal.sources).toContain("TechCrunch");
  });
});

describe("resolveProfile", () => {
  test("a non-object repairs to the defaults", () => {
    for (const raw of [null, undefined, "profile", 7, []]) {
      expect(resolveProfile(raw)).toEqual(DEFAULT_PROFILE);
    }
  });

  test("returns a fresh object every time, never the module constant", () => {
    const a = resolveProfile(null);
    const b = resolveProfile(null);
    expect(a).not.toBe(DEFAULT_PROFILE);
    expect(a.hiringSignal).not.toBe(DEFAULT_PROFILE.hiringSignal);
    expect(a.hiringSignal.sources).not.toBe(DEFAULT_PROFILE.hiringSignal.sources);
    a.hiringSignal.sources.push("mutated");
    expect(b.hiringSignal.sources).not.toContain("mutated");
    expect(DEFAULT_PROFILE.hiringSignal.sources).not.toContain("mutated");
  });

  test("keeps the fields it understands and repairs only the rest", () => {
    const p = resolveProfile({
      searchSubject: "mechanical design and manufacturing engineering",
      querySubject: 42,
    });
    expect(p.searchSubject).toBe("mechanical design and manufacturing engineering");
    expect(p.querySubject).toBe(DEFAULT_PROFILE.querySubject);
  });

  test("a missing fit brain repairs to empty, NOT to a career", () => {
    expect(resolveProfile({}).fitBrain).toBe("");
    expect(resolveProfile({ fitBrain: 12 }).fitBrain).toBe("");
  });

  test("an empty domainBonus is a VALUE, because the block is optional", () => {
    expect(resolveProfile({ domainBonus: "" }).domainBonus).toBe("");
  });

  test("an empty clause tail repairs — the prompt would render a dangling dash", () => {
    const p = resolveProfile({ weakFitTail: "", moderateTail: "   ", strongTail: null });
    expect(p.weakFitTail).toBe(DEFAULT_WEAK_FIT_TAIL);
    expect(p.moderateTail).toBe(DEFAULT_MODERATE_TAIL);
    expect(p.strongTail).toBe(DEFAULT_STRONG_TAIL);
  });

  test("prose where a list belongs repairs to the default list", () => {
    const p = resolveProfile({ hiringSignal: { sources: "TechCrunch and Bloomberg" } });
    expect(p.hiringSignal.sources).toEqual(DEFAULT_PROFILE.hiringSignal.sources);
  });

  test("a list with non-string members drops them rather than rendering [object Object]", () => {
    const p = resolveProfile({
      hiringSignal: { name: "contract awards", sources: ["Defense News", 5, null, "GovWin"] },
    });
    expect(p.hiringSignal.sources).toEqual(["Defense News", "GovWin"]);
  });

  test("over-long text is truncated — the brain is paid once per scored role", () => {
    const long = "x".repeat(PROFILE_TEXT_MAX_CHARS + 500);
    const p = resolveProfile({ fitBrain: long, titleScope: long });
    expect(p.fitBrain.length).toBe(PROFILE_TEXT_MAX_CHARS);
    expect(p.titleScope.length).toBe(PROFILE_TEXT_MAX_CHARS);
  });

  test("hasRecency is a boolean, and a non-boolean does not read as true", () => {
    expect(resolveProfile({ hiringSignal: { hasRecency: "yes" } }).hiringSignal.hasRecency).toBe(true);
    expect(resolveProfile({ hiringSignal: { hasRecency: false } }).hiringSignal.hasRecency).toBe(false);
  });
});

describe("profileToFitInputs", () => {
  test("carries every scoring field across, plus the floor", () => {
    const profile = resolveProfile({
      fitBrain: "A mechanical engineer.",
      weakFitTail: "W",
      moderateTail: "M",
      strongTail: "S",
      titleScope: "- T",
      domainBonus: "D",
    });
    expect(profileToFitInputs(profile, 180000)).toEqual({
      fitBrain: "A mechanical engineer.",
      compFloor: 180000,
      weakFitTail: "W",
      moderateTail: "M",
      strongTail: "S",
      titleScope: "- T",
      domainBonus: "D",
    });
  });

  test("a null floor stays null", () => {
    expect(profileToFitInputs(DEFAULT_PROFILE, null).compFloor).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run lib/profile.test.ts`
Expected: FAIL — `Failed to resolve import "./profile"`.

- [ ] **Step 3: Write `lib/profile.ts`**

```ts
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
    sources: [
      "TechCrunch",
      "Crunchbase",
      "The Information",
      "Bloomberg",
      "Forbes",
      "VentureBeat",
      "Reuters",
      "WSJ",
    ],
    qualifier: "Series B and above",
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
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run lib/profile.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Full gate and commit**

```bash
npm run build && npm test
git add lib/profile.ts lib/profile.test.ts
git commit -m "feat: the per-tenant career profile, shipped with today's values"
```

Expected: 861 + 15 tests green.

---

## Task 2: Store and read the profile — standalone keys, no recursion

**Files:**
- Modify: `lib/settings-store.ts`
- Create: `lib/settings-profile.test.ts`
- Must pass UNEDITED: `lib/settings-store.test.ts`, `lib/settings-effects.test.ts`

**Interfaces:**
- Consumes: `resolveProfile`, `type Profile` from Task 1.
- Produces, from `lib/settings-store.ts`:
  - `const PROFILE_KEY = "profile"`
  - `const ONBOARDED_AT_KEY = "onboarded_at"`
  - `function profileFrom(rows: SettingRow[]): Profile`
  - `function onboardedAtFrom(rows: SettingRow[]): string | null`
  - `async function readOnboardedAtFor(tenantId: string): Promise<string | null>`
  - `async function writeProfile(profile: Profile): Promise<{ error?: string }>`
  - `async function writeOnboardedAt(when?: Date): Promise<{ error?: string }>`

**Why standalone, not `SETTING_KEYS`** — verify this reasoning against
`lib/settings-store.ts:106-116` before writing, it is the documented precedent
for `JOB_STATUSES_KEY` and every word applies: the value is an object,
`mergeSettings` is shape-guarded for the list/text/number values that ARE
criteria fields, and membership would force a fourth shape group plus edits to
two currently-green tests. It also sidesteps an aliasing hazard —
`mergeSettings` copies arrays but not objects (`:145-148`), so an
un-overridden object-valued criteria field would alias the module default for
the life of the process.

**Why `readOnboardedAtFor` takes a tenantId** — this is the fix for revision
2's blocking defect. `resolveTenantId()` is `return (await
requireActor()).tenantId` (`lib/tenant.ts`), so a reader that called it from
inside `requireActorPage()` would recurse unbounded. Every other reader in this
file resolves its own tenant; this one must not, and the comment must say so.

- [ ] **Step 1: Write the failing test**

Create `lib/settings-profile.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import {
  ONBOARDED_AT_KEY,
  PROFILE_KEY,
  SETTING_KEYS,
  onboardedAtFrom,
  profileFrom,
  type SettingRow,
} from "./settings-store";
import { DEFAULT_PROFILE } from "./profile";

describe("the profile keys are STANDALONE", () => {
  test("neither is a member of SETTING_KEYS", () => {
    const values: string[] = Object.values(SETTING_KEYS);
    expect(values).not.toContain(PROFILE_KEY);
    expect(values).not.toContain(ONBOARDED_AT_KEY);
  });

  test("their spellings are pinned — a drift makes every write a silent no-op", () => {
    expect(PROFILE_KEY).toBe("profile");
    expect(ONBOARDED_AT_KEY).toBe("onboarded_at");
  });
});

describe("profileFrom", () => {
  test("no row reads as the shipped profile", () => {
    expect(profileFrom([])).toEqual(DEFAULT_PROFILE);
  });

  test("reads and repairs the stored row", () => {
    const rows: SettingRow[] = [
      { key: PROFILE_KEY, value: { searchSubject: "nursing", querySubject: 5 } },
    ];
    const p = profileFrom(rows);
    expect(p.searchSubject).toBe("nursing");
    expect(p.querySubject).toBe(DEFAULT_PROFILE.querySubject);
  });

  test("ignores every other row", () => {
    const rows: SettingRow[] = [
      { key: SETTING_KEYS.fitBrain, value: "a stored brain" },
      { key: PROFILE_KEY, value: { fitBrain: "the profile's brain" } },
    ];
    expect(profileFrom(rows).fitBrain).toBe("the profile's brain");
  });
});

describe("onboardedAtFrom", () => {
  test("null when the stamp has never been written", () => {
    expect(onboardedAtFrom([])).toBeNull();
  });

  test("reads the stored ISO string", () => {
    expect(
      onboardedAtFrom([{ key: ONBOARDED_AT_KEY, value: "2026-08-17T00:00:00.000Z" }])
    ).toBe("2026-08-17T00:00:00.000Z");
  });

  test("a non-string reads as NEVER, so the gate fails toward onboarding", () => {
    // The safe direction: a hand-edited row that cannot be interpreted sends
    // the user through onboarding again, rather than letting them past the
    // gate with no criteria at all.
    expect(onboardedAtFrom([{ key: ONBOARDED_AT_KEY, value: 1 }])).toBeNull();
    expect(onboardedAtFrom([{ key: ONBOARDED_AT_KEY, value: true }])).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run lib/settings-profile.test.ts`
Expected: FAIL — `PROFILE_KEY` is not exported from `./settings-store`.

- [ ] **Step 3: Edit `lib/settings-store.ts`**

Add the import at the top, beside the existing `resolveStatuses` import:

```ts
import { resolveProfile, type Profile } from "@/lib/profile";
```

Add both keys immediately after `JOB_STATUSES_KEY` (currently `:116`):

```ts
/**
 * Where the tenant's career profile lives — one jsonb document holding the
 * onboarding answers and every prompt fragment that used to be hardcoded.
 *
 * A standalone key, deliberately NOT a member of SETTING_KEYS, for exactly the
 * reasons JOB_STATUSES_KEY above is not: its value is an OBJECT, and
 * mergeSettings is shape-guarded for the list/text/number values that ARE
 * criteria fields. Membership would force a fourth shape group and edits to
 * two currently-green tests, to buy a merge this value never uses — the
 * profile is replaced whole, never merged field-by-field.
 *
 * There is a second reason here that the statuses did not have. mergeSettings
 * copies arrays but NOT objects (see its loop below), so an un-overridden
 * object-valued criteria field would alias this module's default for the life
 * of the process — the exact bug that copy loop exists to prevent, reopened
 * for the one shape it does not handle.
 */
export const PROFILE_KEY = "profile";

/**
 * When this tenant finished onboarding, or absent if they never have.
 *
 * A stamp the app writes, not a setting anyone edits — so it follows
 * CRITERIA_CHANGED_AT_KEY and COMP_SCORING_RESCORED_AT_KEY out of SETTING_KEYS:
 * it is not a `Criteria` field, mergeSettings must never see it, and no
 * settings form may offer it.
 */
export const ONBOARDED_AT_KEY = "onboarded_at";
```

Widen `upsertSetting`'s key union (currently `:342-347`) by exactly the two new
literals — the existing comment already says "Add a literal per stamp; never
`string`":

```ts
async function upsertSetting(
  key:
    | SettingKey
    | typeof CRITERIA_CHANGED_AT_KEY
    | typeof COMP_SCORING_RESCORED_AT_KEY
    | typeof JOB_STATUSES_KEY
    | typeof PROFILE_KEY
    | typeof ONBOARDED_AT_KEY,
  value: unknown
): Promise<{ error?: string }> {
```

Add the four readers/writers next to `jobStatusesFrom` / `writeJobStatuses` at
the bottom of the file:

```ts
/**
 * The career profile out of rows ALREADY read — pure, for the reason
 * jobStatusesFrom and compScoringRescoredFrom are: the settings page and every
 * search path take ONE snapshot of app_settings, and a second read is a second
 * snapshot a concurrent save could split them across.
 */
export function profileFrom(rows: SettingRow[]): Profile {
  return resolveProfile(rows.find((r) => r.key === PROFILE_KEY)?.value ?? null);
}

/**
 * When onboarding finished, out of rows ALREADY read, or null when it never
 * has.
 *
 * A row holding a non-string reads as "never", not as "onboarded". That
 * direction is deliberate and is the opposite of the choice
 * compScoringRescoredFrom makes for its own stamp: there, an uninterpretable
 * value re-offers a rescore, which one click clears. Here, reading it as
 * "onboarded" would let a tenant past the gate with no stored criteria at all,
 * and every search they ran would refuse. Sending them back through onboarding
 * is the recoverable failure.
 */
export function onboardedAtFrom(rows: SettingRow[]): string | null {
  const row = rows.find((r) => r.key === ONBOARDED_AT_KEY);
  return typeof row?.value === "string" ? row.value : null;
}

/**
 * The onboarding stamp for ONE named tenant, taking its own query.
 *
 * TAKES A tenantId AND MUST KEEP TAKING ONE. Every other reader in this file
 * calls resolveTenantId(), which is `(await requireActor()).tenantId`
 * (lib/tenant.ts) — and this reader's only caller is requireActorPage() in
 * lib/require-actor.ts. Resolving the tenant here would therefore call
 * requireActor() from inside requireActor()'s own module-level flow, unbounded.
 * The parameter is what makes the onboarding gate possible at all; a later
 * "tidy-up" that removes it reintroduces an infinite recursion that no type
 * checks.
 *
 * Fails soft to null, like readCriteriaChangedAt: a database blip must not
 * lock a user out of the app, and the cost of the safe direction here is one
 * unnecessary trip through /welcome.
 */
export async function readOnboardedAtFor(tenantId: string): Promise<string | null> {
  const { data, error } = await rawQuery<{ value: string | null }>(
    CRITERIA_CHANGED_AT_SQL,
    [ONBOARDED_AT_KEY, tenantId],
    tenantId
  );
  if (error) {
    console.error(
      `settings-store: could not read "${ONBOARDED_AT_KEY}" — ` +
        `${error.message || UNDESCRIBED_DB_ERROR}.`
    );
    return null;
  }
  return data?.[0]?.value ?? null;
}

/**
 * Stores the whole profile. Lives here, next to the key, for the reason spelled
 * out on writeCriteriaChangedAt: a writer in another module would have to widen
 * upsertSetting's key type to reach it, reopening the typo hazard the constant
 * closes.
 *
 * Resolved before storing, never after — repairs belong in the stored value
 * rather than being re-applied on every read of a profile the user believes
 * they saved. Same rule saveJobStatuses follows.
 */
export async function writeProfile(profile: Profile): Promise<{ error?: string }> {
  return upsertSetting(PROFILE_KEY, resolveProfile(profile));
}

/** Stamps onboarding complete. Stored as a JSON string, matching both other
 *  stamps, so `#>> '{}'` reads it straight back out as text. */
export async function writeOnboardedAt(
  when: Date = new Date()
): Promise<{ error?: string }> {
  return upsertSetting(ONBOARDED_AT_KEY, when.toISOString());
}
```

Note `readOnboardedAtFor` reuses `CRITERIA_CHANGED_AT_SQL` — it is a
key-parameterised `select value #>> '{}' ... where tenant_id = $2 and key = $1`,
not criteria-specific. Add a one-line comment at that constant saying it now
serves two stamps, so the name does not mislead.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run lib/settings-profile.test.ts lib/settings-store.test.ts lib/settings-effects.test.ts`
Expected: PASS. `settings-store.test.ts` and `settings-effects.test.ts` must
pass with **zero edits** — if either fails, a key went into `SETTING_KEYS`.

- [ ] **Step 5: Full gate and commit**

```bash
npm run build && npm test
git add lib/settings-store.ts lib/settings-profile.test.ts
git commit -m "feat: store and read the career profile as a standalone setting"
```

---

## Task 3: Move the two shared search prompts into `lib/`, unchanged

**Files:**
- Create: `lib/company-role-prompt.ts`, `lib/company-role-prompt.test.ts`
- Create: `lib/role-search-prompt.ts`, `lib/role-search-prompt.test.ts`
- Modify: `app/actions/roles.ts`, `lib/crawler.ts`, `app/actions/role-search.ts`

**Interfaces:**
- Consumes: `roleExtractionSchema`, `titleListForPrompt`, `dateContextLine`, `type Criteria` from `@/lib/search-criteria`.
- Produces:
  - `lib/company-role-prompt.ts`: `function buildCompanyRolePrompt(args: { company: string; careersUrl: string | null; criteria: Criteria; searchSubject: string; persona: string; buildingConcept: string; buildingUpside: string }): string`
  - `lib/role-search-prompt.ts`: `const TITLE_FAMILY_INTRO: string`; `function familyIntro(family: RoleSearchFamily, stackFamilyIntro: string): string`; `function buildRoleSearchPrompt(args: { family: RoleSearchFamily; queries: string[]; criteria: Criteria; stackFamilyIntro: string; persona: string; buildingConcept: string; buildingUpside: string; now?: Date }): string`

**Why this move.** `app/actions/role-search.ts` and `app/actions/roles.ts` are
`"use server"` modules: nothing pure can be exported from them and nothing in
them can be reached from a test — the same reason `lib/fit-prompt.ts` exists
apart from `app/actions/parse-role.ts`. The phase-2 guard (Task 5) is a test
asserting that a **changed** profile value reaches the rendered prompt, and it
cannot assert that about a template literal locked inside an action.

**This task changes no rendered text.** `app/actions/roles.ts` and
`lib/crawler.ts` currently hold the same sentence twice; that has been verified
byte-identical after normalising the company expression, so one builder serves
both. Prove it again rather than trusting this paragraph:

```bash
python3 - <<'PY'
def grab(path, start):
    s = open(path).read(); i = s.index(start); j = s.index('`', i); k = s.index('`', j+1)
    return s[j:k+1]
a = grab('app/actions/roles.ts', 'const prompt = `Search for open').replace('${startup.company}', '<C>')
b = grab('lib/crawler.ts', 'prompt: `Search for open').replace('${company}', '<C>')
print("IDENTICAL:", a == b)
PY
```
Expected: `IDENTICAL: True`.

- [ ] **Step 1: Write the failing tests**

Create `lib/company-role-prompt.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { buildCompanyRolePrompt } from "./company-role-prompt";
import { DEFAULT_CRITERIA, roleExtractionSchema, titleListForPrompt } from "./search-criteria";
import { DEFAULT_PROFILE } from "./profile";

const D = DEFAULT_PROFILE;

const withDefaults = (company: string, careersUrl: string | null) =>
  buildCompanyRolePrompt({
    company,
    careersUrl,
    criteria: DEFAULT_CRITERIA,
    searchSubject: D.searchSubject,
    persona: D.candidatePersona,
    buildingConcept: D.buildingConcept,
    buildingUpside: D.buildingUpside,
  });

describe("buildCompanyRolePrompt", () => {
  test("reproduces today's sentence EXACTLY, with a careers-page hint", () => {
    const hint = ` Their careers page may be: https://acme.com/careers.`;
    const expected = `Search for open ${D.searchSubject} roles at "Acme".${hint} Look for these titles: ${titleListForPrompt(DEFAULT_CRITERIA)}. Visit each job posting URL if available to extract the full details. IMPORTANT location filter: ${DEFAULT_CRITERIA.locationRule}

${roleExtractionSchema(D.candidatePersona, D.buildingConcept, D.buildingUpside)}

If no qualifying roles are found, return a JSON object: {"roles": [], "message": "explanation"}. Otherwise return ONLY the JSON array.`;
    expect(withDefaults("Acme", "https://acme.com/careers")).toBe(expected);
  });

  test("with no careers URL the hint vanishes and no double space is left", () => {
    const prompt = withDefaults("Acme", null);
    expect(prompt).toContain(`roles at "Acme". Look for these titles:`);
    expect(prompt).not.toContain("  ");
  });

  test("renders every career-specific value it is HANDED, never a default", () => {
    // The phase-2 guard in miniature. A required parameter catches OMISSION,
    // which was phase 1's risk; a site that keeps passing the GTM constant
    // compiles and ships. Only an assertion that a CHANGED value reaches the
    // output can catch that.
    const prompt = buildCompanyRolePrompt({
      company: "Acme",
      careersUrl: null,
      criteria: DEFAULT_CRITERIA,
      searchSubject: "SYNTHETIC SUBJECT",
      persona: "SYNTHETIC PERSONA",
      buildingConcept: "SYNTHETIC CONCEPT",
      buildingUpside: "SYNTHETIC UPSIDE",
    });
    expect(prompt).toContain("SYNTHETIC SUBJECT");
    expect(prompt).toContain("SYNTHETIC PERSONA");
    expect(prompt).toContain("SYNTHETIC CONCEPT");
    expect(prompt).toContain("SYNTHETIC UPSIDE");
    expect(prompt).not.toContain(D.searchSubject);
    expect(prompt).not.toContain(D.candidatePersona);
    expect(prompt).not.toContain(D.buildingConcept);
    expect(prompt).not.toContain(D.buildingUpside);
  });
});
```

Create `lib/role-search-prompt.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { TITLE_FAMILY_INTRO, buildRoleSearchPrompt, familyIntro } from "./role-search-prompt";
import { DEFAULT_CRITERIA, dateContextLine, roleExtractionSchema } from "./search-criteria";
import { DEFAULT_PROFILE } from "./profile";

const D = DEFAULT_PROFILE;
const QUERIES = ['"Head of GTM Systems" Denver job opening', '"Salesforce" revenue operations hiring Denver'];
const NOW = new Date("2026-08-17T12:00:00.000Z");

const withDefaults = (family: "title" | "stack") =>
  buildRoleSearchPrompt({
    family,
    queries: QUERIES,
    criteria: DEFAULT_CRITERIA,
    stackFamilyIntro: D.stackFamilyIntro,
    persona: D.candidatePersona,
    buildingConcept: D.buildingConcept,
    buildingUpside: D.buildingUpside,
    now: NOW,
  });

describe("familyIntro", () => {
  test("the title family's intro is career-agnostic as written and is a constant", () => {
    expect(familyIntro("title", D.stackFamilyIntro)).toBe(TITLE_FAMILY_INTRO);
    expect(TITLE_FAMILY_INTRO).toBe(
      "Search job boards and company careers pages for currently-open roles matching these searches"
    );
  });

  test("the stack family's intro is the whole handed sentence", () => {
    expect(familyIntro("stack", "SYNTHETIC INTRO")).toBe("SYNTHETIC INTRO");
  });
});

describe("buildRoleSearchPrompt", () => {
  test("reproduces today's stack-family prompt EXACTLY", () => {
    const expected = `${D.stackFamilyIntro}:

${QUERIES.map((q) => `- ${q}`).join("\n")}

Run as many of these searches as you can and combine the results. ${dateContextLine(NOW)} Prioritize postings from the last 60 days. ${DEFAULT_CRITERIA.locationRule}

${roleExtractionSchema(D.candidatePersona, D.buildingConcept, D.buildingUpside)}
- company (string, the hiring company name — REQUIRED, never empty)

Return up to 25 roles. Deduplicate identical postings. Return ONLY the JSON array.`;
    expect(withDefaults("stack")).toBe(expected);
  });

  test("the title family differs from the stack family ONLY by its intro", () => {
    const title = withDefaults("title");
    const stack = withDefaults("stack");
    expect(title.replace(TITLE_FAMILY_INTRO, "<INTRO>")).toBe(
      stack.replace(D.stackFamilyIntro, "<INTRO>")
    );
  });

  test("renders every career-specific value it is HANDED, never a default", () => {
    const prompt = buildRoleSearchPrompt({
      family: "stack",
      queries: QUERIES,
      criteria: DEFAULT_CRITERIA,
      stackFamilyIntro: "SYNTHETIC INTRO",
      persona: "SYNTHETIC PERSONA",
      buildingConcept: "SYNTHETIC CONCEPT",
      buildingUpside: "SYNTHETIC UPSIDE",
      now: NOW,
    });
    expect(prompt).toContain("SYNTHETIC INTRO");
    expect(prompt).toContain("SYNTHETIC PERSONA");
    expect(prompt).toContain("SYNTHETIC CONCEPT");
    expect(prompt).toContain("SYNTHETIC UPSIDE");
    expect(prompt).not.toContain(D.stackFamilyIntro);
    expect(prompt).not.toContain(D.candidatePersona);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run lib/company-role-prompt.test.ts lib/role-search-prompt.test.ts`
Expected: FAIL — both modules unresolved.

- [ ] **Step 3: Write the two builders**

`lib/company-role-prompt.ts`:

```ts
// The per-company role-search prompt, shared by Discover's "Find Roles" button
// (app/actions/roles.ts) and the crawler's search tier (lib/crawler.ts).
//
// It lived in both files as the same template literal, character for character.
// Out here it is one string, and — more importantly — it is PURE, so a test can
// assert that a changed profile value actually reaches the model. Neither
// caller could be tested: both are modules that read the database and call
// Claude, and app/actions/roles.ts is additionally "use server", which forbids
// non-async exports.

import { roleExtractionSchema, titleListForPrompt, type Criteria } from "@/lib/search-criteria";

export function buildCompanyRolePrompt(args: {
  company: string;
  /** The company's careers page, when one is known. Adds a hint sentence. */
  careersUrl: string | null;
  criteria: Criteria;
  /** The field, in PROSE. profile.searchSubject — never the query form. */
  searchSubject: string;
  persona: string;
  buildingConcept: string;
  buildingUpside: string;
}): string {
  const hint = args.careersUrl ? ` Their careers page may be: ${args.careersUrl}.` : "";
  return `Search for open ${args.searchSubject} roles at "${args.company}".${hint} Look for these titles: ${titleListForPrompt(args.criteria)}. Visit each job posting URL if available to extract the full details. IMPORTANT location filter: ${args.criteria.locationRule}

${roleExtractionSchema(args.persona, args.buildingConcept, args.buildingUpside)}

If no qualifying roles are found, return a JSON object: {"roles": [], "message": "explanation"}. Otherwise return ONLY the JSON array.`;
}
```

`lib/role-search-prompt.ts`:

```ts
// The keyword role-search prompt (app/actions/role-search.ts), out here for the
// reason lib/fit-prompt.ts is out of app/actions/parse-role.ts: "use server"
// forbids non-async exports, so nothing in that action can be exported pure or
// reached from a test — and this prompt now carries per-tenant text that a test
// has to be able to see.

import { dateContextLine, roleExtractionSchema, type Criteria } from "@/lib/search-criteria";
import type { RoleSearchFamily } from "@/lib/types";

/**
 * The title family's intro.
 *
 * Career-agnostic as written — it names no field and no titles, because the
 * titles are in the query list beneath it — so it stays a constant rather than
 * becoming a profile field. The stack family's intro is the opposite case: it
 * names three GTM job titles after its subject, which is why the whole sentence
 * is per-tenant (profile.stackFamilyIntro).
 */
export const TITLE_FAMILY_INTRO =
  "Search job boards and company careers pages for currently-open roles matching these searches";

export function familyIntro(family: RoleSearchFamily, stackFamilyIntro: string): string {
  return family === "title" ? TITLE_FAMILY_INTRO : stackFamilyIntro;
}

export function buildRoleSearchPrompt(args: {
  family: RoleSearchFamily;
  queries: string[];
  criteria: Criteria;
  stackFamilyIntro: string;
  persona: string;
  buildingConcept: string;
  buildingUpside: string;
  /** Injected so the date line is pinnable. Defaults to now, as it did inline. */
  now?: Date;
}): string {
  return `${familyIntro(args.family, args.stackFamilyIntro)}:

${args.queries.map((q) => `- ${q}`).join("\n")}

Run as many of these searches as you can and combine the results. ${dateContextLine(args.now)} Prioritize postings from the last 60 days. ${args.criteria.locationRule}

${roleExtractionSchema(args.persona, args.buildingConcept, args.buildingUpside)}
- company (string, the hiring company name — REQUIRED, never empty)

Return up to 25 roles. Deduplicate identical postings. Return ONLY the JSON array.`;
}
```

`dateContextLine`'s signature is `(now: Date = new Date())`, so passing
`args.now` (possibly `undefined`) reproduces today's behaviour exactly. Verify
that default is still there before relying on it.

- [ ] **Step 4: Rewire the three call sites, changing nothing else**

In `app/actions/roles.ts`: delete the inline `const prompt = ...` and the `hint`
line above it; call `buildCompanyRolePrompt({ company: startup.company,
careersUrl: startup.careers_url ?? null, criteria, searchSubject:
SEARCH_SUBJECT, persona: CANDIDATE_PERSONA, buildingConcept: BUILDING_CONCEPT,
buildingUpside: BUILDING_UPSIDE })`. Leave `roleSearchSystem(SEARCH_SUBJECT)`
and `maxTokens: 8000` and its comment alone.

In `lib/crawler.ts` `extractViaSearch`: same substitution, `careersUrl` is
already the parameter.

In `app/actions/role-search.ts`: delete `FAMILY_INTRO` and `buildPrompt`; call
`buildRoleSearchPrompt({ family, queries, criteria, stackFamilyIntro:
STACK_FAMILY_INTRO, persona: CANDIDATE_PERSONA, buildingConcept:
BUILDING_CONCEPT, buildingUpside: BUILDING_UPSIDE })`.

Remove the now-unused imports from each file (`tsc` will name them).

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: PASS. `app/actions/roles.test.ts` mocks `@/lib/search-criteria`
(`:81-90`) — its mock supplies `roleExtractionSchema: () => "schema"`, which
the new builder still calls, so the mock keeps working. If that file needs an
edit, read why before making it: the assertion it protects is about the
Claude call's shape, not about prompt text.

- [ ] **Step 6: Full gate and commit**

```bash
npm run build && npm test
git add lib/company-role-prompt.ts lib/company-role-prompt.test.ts \
        lib/role-search-prompt.ts lib/role-search-prompt.test.ts \
        app/actions/roles.ts app/actions/role-search.ts lib/crawler.ts
git commit -m "refactor: the two shared search prompts move to lib, unchanged"
```

---

## Task 4: `FitInputs` comes from the profile

**Files:**
- Modify: `lib/search-criteria.ts` (`scoringInputsFrom`, `loadSearchInputs`, `loadScoringInputs`, `loadCriteriaAndScoringInputs`)
- Modify: `lib/search-criteria.test.ts` (only where it constructs `FitInputs` by hand)
- Create: `lib/profile-scoring.test.ts`

**Interfaces:**
- Consumes: `profileFrom` (Task 2), `profileToFitInputs` (Task 1).
- Produces: `scoringInputsFrom(criteria, rows)` unchanged in signature, changed in body — it now reads the profile out of the same `rows`.

The signature does not change, so no caller does. That is the point: the four
loaders already take one snapshot of `app_settings` and derive everything from
it, and the profile is one more row in that snapshot.

- [ ] **Step 1: Write the failing test**

Create `lib/profile-scoring.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { DEFAULT_CRITERIA, scoringInputsFrom } from "./search-criteria";
import { PROFILE_KEY, SETTING_KEYS, type SettingRow } from "./settings-store";
import { DEFAULT_PROFILE } from "./profile";
import { buildFitPrompt } from "./fit-prompt";
import { FIXTURE_ROLE } from "./__fixtures__/fit-prompt-inputs";

describe("scoringInputsFrom, sourced from the profile", () => {
  test("with no profile row it reproduces the shipped scoring text", () => {
    const inputs = scoringInputsFrom(DEFAULT_CRITERIA, []);
    expect(inputs.weakFitTail).toBe(DEFAULT_PROFILE.weakFitTail);
    expect(inputs.moderateTail).toBe(DEFAULT_PROFILE.moderateTail);
    expect(inputs.strongTail).toBe(DEFAULT_PROFILE.strongTail);
    expect(inputs.titleScope).toBe(DEFAULT_PROFILE.titleScope);
    expect(inputs.domainBonus).toBe(DEFAULT_PROFILE.domainBonus);
  });

  test("A STORED PROFILE REACHES THE RENDERED FIT PROMPT", () => {
    // This is phase 2's guard, end to end and in one assertion: a value stored
    // by onboarding must come out the other side of buildFitPrompt. A site
    // that kept passing the GTM constant would compile, type-check, pass every
    // fixture (they ARE the constants) and ship GTM text to a nurse. Only a
    // CHANGED value can tell the two apart.
    const rows: SettingRow[] = [
      {
        key: PROFILE_KEY,
        value: {
          fitBrain: "SYNTHETIC BRAIN",
          weakFitTail: "SYNTHETIC WEAK",
          moderateTail: "SYNTHETIC MODERATE",
          strongTail: "SYNTHETIC STRONG",
          titleScope: "- SYNTHETIC SCOPE",
          domainBonus: "SYNTHETIC BONUS",
        },
      },
      { key: SETTING_KEYS.compFloor, value: 180000 },
    ];
    const inputs = scoringInputsFrom(DEFAULT_CRITERIA, rows);
    const prompt = buildFitPrompt(FIXTURE_ROLE, inputs);

    expect(prompt).toContain("SYNTHETIC BRAIN");
    expect(prompt).toContain("SYNTHETIC WEAK");
    expect(prompt).toContain("SYNTHETIC MODERATE");
    expect(prompt).toContain("SYNTHETIC STRONG");
    expect(prompt).toContain("- SYNTHETIC SCOPE");
    expect(prompt).toContain("SYNTHETIC BONUS");

    expect(prompt).not.toContain(DEFAULT_PROFILE.weakFitTail);
    expect(prompt).not.toContain(DEFAULT_PROFILE.moderateTail);
    expect(prompt).not.toContain(DEFAULT_PROFILE.strongTail);
    expect(prompt).not.toContain(DEFAULT_PROFILE.titleScope);
    expect(prompt).not.toContain(DEFAULT_PROFILE.domainBonus);
    // The floor is NOT a profile field and still rides in off its own row.
    expect(prompt).toContain("$180,000");
  });

  test("the fit brain comes from the profile, not from criteria.fitBrain", () => {
    // criteria.fitBrain is the legacy `fitBrain` SETTING_KEYS row. The profile
    // is the source of truth now; the setting row is what /settings edits and
    // Task 11 keeps them in step.
    const rows: SettingRow[] = [{ key: PROFILE_KEY, value: { fitBrain: "FROM THE PROFILE" } }];
    expect(scoringInputsFrom({ ...DEFAULT_CRITERIA, fitBrain: "FROM CRITERIA" }, rows).fitBrain).toBe(
      "FROM THE PROFILE"
    );
  });

  test("an absent profile fit brain falls back to the criteria row, not to a career", () => {
    // The /settings fit-brain editor writes the SETTING_KEYS row. A tenant who
    // edits it there without re-running onboarding must still be scored against
    // what they typed.
    const inputs = scoringInputsFrom({ ...DEFAULT_CRITERIA, fitBrain: "EDITED ON SETTINGS" }, []);
    expect(inputs.fitBrain).toBe("EDITED ON SETTINGS");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run lib/profile-scoring.test.ts`
Expected: FAIL — the stored profile's synthetic values do not appear; the
`DEFAULT_*` constants do.

- [ ] **Step 3: Rewrite `scoringInputsFrom` in `lib/search-criteria.ts`**

```ts
/**
 * The scoring inputs implied by ONE snapshot of app_settings.
 *
 * Takes the already-merged criteria plus the rows they were merged from, so a
 * caller that needed the criteria anyway derives the fit inputs from the same
 * read rather than taking a second one. `compFloor` is NOT a `Criteria` field
 * and the PROFILE is not one either — both are read straight off the rows,
 * which is why the rows have to come along.
 *
 * Every career-specific field now comes from the tenant's profile
 * (lib/profile.ts). This function used to hand `buildFitPrompt` five module
 * constants; it hands it five stored values instead, and lib/profile-scoring.test.ts
 * pins that a CHANGED value reaches the rendered prompt — the guard that a
 * required parameter cannot provide.
 *
 * The fit brain has TWO sources and the precedence is deliberate: the profile's
 * brain wins, and the `fitBrain` SETTING_KEYS row is the fallback. Onboarding
 * writes both (see saveProfile), so they agree; a later edit on /settings
 * writes only the row, and this ordering is what makes that edit take effect
 * for a tenant whose profile predates it.
 */
export function scoringInputsFrom(criteria: Criteria, rows: SettingRow[]): FitInputs {
  const profile = profileFrom(rows);
  return profileToFitInputs(
    { ...profile, fitBrain: profile.fitBrain || criteria.fitBrain },
    compFloorFrom(rows)
  );
}
```

Add imports: `profileFrom` from `@/lib/settings-store`, `profileToFitInputs`
from `@/lib/profile`. Delete the five `DEFAULT_*` imports from
`@/lib/fit-prompt` **only if nothing else in the file uses them** — check with
`grep -n "DEFAULT_WEAK_FIT_TAIL\|DEFAULT_TITLE_SCOPE" lib/search-criteria.ts`
before removing.

`lib/search-criteria.test.ts` constructs `FitInputs` by hand in seven places
(around `:459`, `:537`, `:559`, `:579`, `:592`, `:610`). Those are direct
`FitInputs` literals, not calls to `scoringInputsFrom`, so they compile
unchanged. Change one only if `tsc` says so, and if it does, read what the
test was asserting first.

- [ ] **Step 4: Run everything**

Run: `npm test`
Expected: PASS, including all three fit-prompt fixtures byte-identical.

- [ ] **Step 5: Commit**

```bash
npm run build && npm test
git add lib/search-criteria.ts lib/profile-scoring.test.ts
git commit -m "feat: fit scoring reads the tenant's profile, not a module constant"
```

---

## Task 5: The search and extraction prompts read the profile — the atomic switch

**Files:**
- Modify: `lib/search-criteria.ts` (`stackQueries`, the loaders, re-export the defaults from `lib/profile.ts`)
- Modify: `lib/crawler.ts` (`RunContext`, `loadRunContext`, `buildExtractionPrompt`, both tiers)
- Modify: `app/actions/roles.ts`, `app/actions/role-search.ts`
- Create: `lib/career-neutrality.test.ts`
- Modify: `lib/search-criteria.test.ts`, `lib/crawler.test.ts`, `lib/search-subject.test.ts` where they reference moved constants

**This is the commit the phase-1 spec called "one atomic commit".** Every
remaining prompt site stops reading a module constant and starts reading the
profile, in one change, so no intermediate state ships half a career.

**Interfaces:**
- Produces:
  - `stackQueries(criteria: Criteria, querySubject: string): string[]` — the module-level `QUERY_SUBJECT` becomes a parameter
  - `loadSearchInputs(): Promise<{ criteria; ceiling; fitInputs; profile }>`
  - `loadCriteriaAndScoringInputs(): Promise<{ criteria; fitInputs; profile }>`
  - `RunContext { criteria; fitInputs; profile; criteriaChangedAt }`
  - `buildExtractionPrompt(company, page, criteria, persona, buildingConcept, buildingUpside)` — signature unchanged, callers now pass profile fields

**Constant consolidation.** Task 1 duplicated seven strings into
`DEFAULT_PROFILE`. This task deletes the originals from `lib/search-criteria.ts`
(`SEARCH_SUBJECT`, `QUERY_SUBJECT`, `STACK_FAMILY_INTRO`, `CANDIDATE_PERSONA`,
`BUILDING_CONCEPT`, `BUILDING_UPSIDE`) and, where a test still wants them by
name, re-exports them from `lib/profile.ts` as fields of `DEFAULT_PROFILE`.
There must be exactly one copy of each string in `lib/` when this task is done
— verify with:

```bash
grep -rn "go-to-market and revenue operations" lib app components | grep -v "\.test\." | grep -v __fixtures__
```
Expected: one hit, `lib/profile.ts`.

- [ ] **Step 1: Write the failing guard test**

Create `lib/career-neutrality.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { DEFAULT_PROFILE } from "./profile";

/**
 * THE PHASE-2 GUARD.
 *
 * Phase 1's post-mortem states the risk this test exists for: "Required
 * parameters buy less than they appear to. They catch OMISSION, which is a
 * phase-1 risk. A phase-2 site that forgets to switch its argument keeps
 * passing CANDIDATE_PERSONA — compiles, type-checks, ships GTM text to a
 * nurse."
 *
 * Two halves, and both are needed. The per-builder tests assert a CHANGED value
 * reaches the rendered prompt; this one asserts no production module can reach
 * a career-specific string at all. A builder test cannot see a call site, and a
 * call site inside a "use server" module cannot be called from a test.
 *
 * Precedent for reading source in a test: lib/job-statuses.test.ts, which walks
 * the tree asserting no Tailwind arbitrary-value class escapes app/ or
 * components/.
 */

const ROOT = path.resolve(__dirname, "..");

/** Where a career-specific string is ALLOWED to appear. */
const HOMES = new Set([
  "lib/profile.ts",
  "lib/fit-prompt.ts",
  "lib/__fixtures__/fit-golden-set.json",
]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === ".git") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const FILES = [
  ...sourceFiles(path.join(ROOT, "lib")),
  ...sourceFiles(path.join(ROOT, "app")),
  ...sourceFiles(path.join(ROOT, "components")),
].map((f) => ({ rel: path.relative(ROOT, f), text: readFileSync(f, "utf8") }));

describe("no production module holds a career-specific string", () => {
  const PHRASES: [string, string][] = [
    ["searchSubject", DEFAULT_PROFILE.searchSubject],
    ["querySubject", DEFAULT_PROFILE.querySubject],
    ["stackFamilyIntro", DEFAULT_PROFILE.stackFamilyIntro],
    ["candidatePersona", DEFAULT_PROFILE.candidatePersona],
    ["buildingConcept", DEFAULT_PROFILE.buildingConcept],
    ["buildingUpside", DEFAULT_PROFILE.buildingUpside],
    ["weakFitTail", DEFAULT_PROFILE.weakFitTail],
    ["moderateTail", DEFAULT_PROFILE.moderateTail],
    ["strongTail", DEFAULT_PROFILE.strongTail],
  ];

  for (const [field, phrase] of PHRASES) {
    test(`${field}'s text appears only in its home module`, () => {
      const offenders = FILES.filter(
        (f) => !HOMES.has(f.rel) && f.text.includes(phrase)
      ).map((f) => f.rel);
      expect(offenders, `move this text into the profile: ${field}`).toEqual([]);
    });
  }

  test("no module outside lib/profile.ts imports a deleted GTM constant", () => {
    // Names, not text: a re-introduced `SEARCH_SUBJECT` import would pass the
    // phrase checks above (the string lives in profile.ts) while pinning a
    // call site to one career again.
    const GONE = [
      "SEARCH_SUBJECT",
      "QUERY_SUBJECT",
      "STACK_FAMILY_INTRO",
      "CANDIDATE_PERSONA",
      "BUILDING_CONCEPT",
      "BUILDING_UPSIDE",
    ];
    for (const name of GONE) {
      const offenders = FILES.filter((f) =>
        new RegExp(`\\b${name}\\b`).test(f.text)
      ).map((f) => f.rel);
      expect(offenders, `${name} was deleted in phase 2`).toEqual([]);
    }
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run lib/career-neutrality.test.ts`
Expected: FAIL, naming `lib/search-criteria.ts`, `lib/crawler.ts`,
`app/actions/roles.ts`, `app/actions/role-search.ts`.

- [ ] **Step 3: Delete the constants and thread the profile**

In `lib/search-criteria.ts`:

1. Delete `SEARCH_SUBJECT`, `QUERY_SUBJECT`, `STACK_FAMILY_INTRO`,
   `CANDIDATE_PERSONA`, `BUILDING_CONCEPT`, `BUILDING_UPSIDE` and their
   docblocks. **Move the docblocks' reasoning onto the matching `Profile`
   fields in `lib/profile.ts`** rather than deleting it — the split-per-
   grammatical-form ruling and the `af8bd83` history are the reason those
   fields are separate, and losing that comment is how they get merged again.
2. `stackQueries` takes the subject:

```ts
/**
 * Queries that catch roles with idiosyncratic titles.
 *
 * `querySubject` is the SHORT form (profile.querySubject) — two words where the
 * prose subject is four. A query is not a sentence: the longer phrase makes the
 * query worse, not more precise, so one generated value does not serve both.
 */
export function stackQueries(criteria: Criteria, querySubject: string): string[] {
  const queries: string[] = [];
  for (const tool of criteria.stackTerms) {
    for (const place of criteria.locations) {
      queries.push(`"${tool}" ${querySubject} hiring ${place}`);
    }
  }
  return queries;
}
```

3. `roleSearchSystem`'s docblock currently explains why its parameter is
   required and says phase 2 "needs its own guard — which is what the golden
   tests asserting a CHANGED value reaches the output are for". Update it to
   name the guard that now exists: `lib/career-neutrality.test.ts` and the
   per-builder handed-value tests.
4. The three loaders return the profile alongside what they already return:

```ts
export async function loadSearchInputs(): Promise<{
  criteria: Criteria;
  ceiling: number | null;
  fitInputs: FitInputs;
  profile: Profile;
}> {
  const rows = await readAllSettings();
  const criteria = mergeSettings(DEFAULT_CRITERIA, rows);
  // The profile comes off the SAME rows as the criteria and the fit inputs.
  // A search that built its prompt from one snapshot's profile and scored what
  // it found against another's is the split this function exists to prevent.
  return {
    criteria,
    ceiling: ceilingFrom(rows),
    fitInputs: scoringInputsFrom(criteria, rows),
    profile: profileFrom(rows),
  };
}
```

Do the same for `loadCriteriaAndScoringInputs`. `loadScoringInputs` needs no
profile in its return — it feeds `scoreFit` only — but its body already routes
through `scoringInputsFrom`, so it picks the profile up for free.

In `lib/crawler.ts`:

```ts
export interface RunContext {
  criteria: Criteria;
  fitInputs: FitInputs;
  /** The tenant's career profile — every prompt fragment this run interpolates. */
  profile: Profile;
  criteriaChangedAt: string | null;
}
```

`loadRunContext` destructures `profile` out of `loadCriteriaAndScoringInputs`
and includes it. `extractViaFetch` and `extractViaSearch` each take the
profile (they already take `criteria`); replace
`roleSearchSystem(SEARCH_SUBJECT)` with `roleSearchSystem(profile.searchSubject)`
in both, `buildExtractionPrompt(..., CANDIDATE_PERSONA, BUILDING_CONCEPT,
BUILDING_UPSIDE)` with the profile fields, and the search-tier prompt with
`buildCompanyRolePrompt({ ..., searchSubject: profile.searchSubject, persona:
profile.candidatePersona, ... })`. Follow the compile errors to every caller of
those two functions.

In `app/actions/roles.ts`: `const { criteria, fitInputs, profile } = await
loadCriteriaAndScoringInputs();` then pass `profile.*` into
`buildCompanyRolePrompt` and `roleSearchSystem(profile.searchSubject)`.

In `app/actions/role-search.ts`: `const { criteria, ceiling, fitInputs, profile
} = await loadSearchInputs();`; `allQueriesFor` takes the profile so
`stackQueries(criteria, profile.querySubject)` compiles;
`buildRoleSearchPrompt({ ..., stackFamilyIntro: profile.stackFamilyIntro,
persona: profile.candidatePersona, ... })`;
`roleSearchSystem(profile.searchSubject)`.

- [ ] **Step 4: Fix the tests that named the deleted constants**

`lib/search-subject.test.ts` imports `SEARCH_SUBJECT`, `STACK_FAMILY_INTRO`,
`roleSearchSystem`. Its assertions are still worth keeping — they pin that the
rendered sentence is right and that the stack intro carries its three example
titles — so re-point them at `DEFAULT_PROFILE.searchSubject` /
`DEFAULT_PROFILE.stackFamilyIntro` rather than deleting them.

`lib/search-criteria.test.ts` and `lib/crawler.test.ts` import the persona
trio; re-point them the same way. `lib/search-criteria.test.ts:149` asserts
`QUERY_SUBJECT` is `"revenue operations"` — that assertion moves to
`lib/profile.test.ts`, where Task 1 already wrote it, so delete it here rather
than duplicating it.

`app/actions/roles.test.ts:81-90` mocks the module with the old constant names;
update the mock to whatever `roles.ts` now imports. If it imports nothing from
`search-criteria` but `loadCriteriaAndScoringInputs`, the mock shrinks.

- [ ] **Step 5: Run everything**

Run: `npm run build && npm test`
Expected: PASS, `lib/career-neutrality.test.ts` green, all three fit-prompt
fixtures byte-identical, no test count regression.

- [ ] **Step 6: Verify the harness before trusting it**

Phase 1's ruling: *"A harness that has never failed has not been shown to
work."* Mutate one character and confirm each guard fails:

```bash
# 1. Re-introduce a GTM string in a production module.
sed -i '' 's/profile.searchSubject/"go-to-market and revenue operations"/' app/actions/roles.ts
npx vitest run lib/career-neutrality.test.ts   # MUST FAIL
git checkout app/actions/roles.ts

# 2. Ignore a handed value in a builder.
sed -i '' 's/${args.persona}/${"GTM Systems \/ RevOps \/ Marketing Ops leader and AI practitioner-builder"}/' lib/company-role-prompt.ts
npx vitest run lib/company-role-prompt.test.ts # MUST FAIL
git checkout lib/company-role-prompt.ts
```

If either passes, the guard is decoration. Fix it before continuing.

- [ ] **Step 7: Commit**

```bash
npm run build && npm test
git add -A lib app
git commit -m "feat: every search and extraction prompt reads the tenant's profile"
```

---

## Task 6: An empty fit brain refuses, loudly

**Files:**
- Modify: `lib/search-criteria.ts` (`DEFAULT_FIT_BRAIN`, `emptySearchReason`)
- Modify: `app/actions/parse-role.ts` (`scoreFitInner`)
- Modify: `lib/search-criteria.test.ts` (extend the `emptySearchReason` block)
- Create: `app/actions/parse-role-empty-brain.test.ts`

`DEFAULT_FIT_BRAIN` stops being a working fallback. That is the point: with
real tenants, a fallback means any gap in the gate scores a stranger's roles
against someone else's background. The consequence is accepted in the spec —
a tenant who somehow reaches a search un-onboarded gets an error instead of
results.

- [ ] **Step 1: Write the failing tests**

Append to `lib/search-criteria.test.ts`'s existing `emptySearchReason` describe
block:

```ts
  test("an empty fit brain refuses BOTH families, and says what to do", () => {
    for (const family of ["title", "stack"] as const) {
      const reason = emptySearchReason(family, { ...DEFAULT_CRITERIA, fitBrain: "" });
      expect(reason).toBeTruthy();
      expect(reason).toContain("fit brain");
    }
  });

  test("a whitespace-only fit brain is empty too", () => {
    expect(emptySearchReason("title", { ...DEFAULT_CRITERIA, fitBrain: "   \n " })).toBeTruthy();
  });

  test("a present fit brain with full lists still refuses nothing", () => {
    expect(
      emptySearchReason("title", { ...DEFAULT_CRITERIA, fitBrain: "A candidate." })
    ).toBeNull();
  });

  test("the missing-brain reason is listed alongside missing lists, not instead", () => {
    const reason = emptySearchReason("title", {
      ...DEFAULT_CRITERIA,
      titles: [],
      fitBrain: "",
    });
    expect(reason).toContain("target titles");
    expect(reason).toContain("fit brain");
  });
```

Create `app/actions/parse-role-empty-brain.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { emptyBrainRefusal } from "@/lib/search-criteria";

describe("emptyBrainRefusal", () => {
  test("names the fit brain and points at where to fix it", () => {
    expect(emptyBrainRefusal()).toContain("fit brain");
    expect(emptyBrainRefusal()).toMatch(/Settings|onboarding/);
  });

  test("is never empty — a caller's presence check depends on it", () => {
    // Same contract the closed-set string in scoreFit's catch has: the message
    // is non-empty on every path, so `error !== undefined` separates failure
    // from success without the text having to be truthy.
    expect(emptyBrainRefusal().length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run and confirm they fail**

Run: `npx vitest run lib/search-criteria.test.ts app/actions/parse-role-empty-brain.test.ts`
Expected: FAIL — `emptyBrainRefusal` is not exported; the fit-brain arm does
not exist.

- [ ] **Step 3: Implement**

In `lib/search-criteria.ts`:

```ts
/**
 * EMPTY, deliberately, and this is the whole reason the onboarding flow exists.
 *
 * This constant used to be one person's résumé, and `loadCriteria` fell back to
 * it whenever a tenant had saved nothing — so a second user could sign in, be
 * approved, and have every role they found scored against a stranger's career,
 * with nothing on screen to say so. Silent wrongness is the failure this
 * codebase consistently chooses to fail loudly on instead (see
 * describeWriteFailure, and the whole .claude/skills/swallowed-string-errors
 * doctrine).
 *
 * Consequence, accepted: a tenant who reaches a search un-onboarded gets an
 * error rather than results. emptySearchReason below is where that error is
 * worded, and it is the ACTION-LEVEL onboarding gate — a guard can be forgotten
 * on a new action, whereas empty criteria protect every path not yet written.
 */
export const DEFAULT_FIT_BRAIN = "";
```

Extend `emptySearchReason` — note it must keep listing every missing thing, not
return on the first:

```ts
export function emptySearchReason(
  family: RoleSearchFamily,
  criteria: Criteria
): string | null {
  const missing: string[] = [];
  if (family === "title" && criteria.titles.length === 0) missing.push("target titles");
  if (family === "stack" && criteria.stackTerms.length === 0) missing.push("stack terms");
  if (criteria.locations.length === 0) missing.push("location terms");
  // The fit brain is not a query input — the search would run without it — but
  // every role it found would then be scored against nothing, which reads as
  // "the market has nothing good" rather than as a missing profile. Refusing
  // before the call is what keeps a billed search from producing meaningless
  // scores.
  if (!criteria.fitBrain.trim()) missing.push("fit brain");
  if (missing.length === 0) return null;
  return (
    `Cannot run the ${family} search: your ${missing.join(" and ")} ` +
    `${missing.length === 1 ? "is" : "are"} empty. ` +
    `Finish onboarding, or fill this in on the Settings page.`
  );
}

/**
 * Why a fit score cannot be computed. Non-empty on every path, so a caller's
 * `error !== undefined` check works without the text having to be truthy.
 */
export function emptyBrainRefusal(): string {
  return (
    "This role cannot be scored yet: your fit brain is empty, so there is " +
    "nothing to score it against. Finish onboarding, or write one on the " +
    "Settings page."
  );
}
```

The existing `emptySearchReason` tests assert its old wording ("so there are no
queries to send", "Add at least one entry on the Settings page"). Read them,
then update the expectations to the new sentence — do not weaken them to
`toBeTruthy()`.

In `app/actions/parse-role.ts`, first statement inside `scoreFitInner`'s `try`,
after resolving `fitInputs`:

```ts
    const fitInputs = opts.fitInputs ?? (await loadScoringInputs());
    // Refused BEFORE the model call. With an empty brain buildFitPrompt renders
    // "CANDIDATE:" over a blank line and the model scores against the role
    // alone — a plausible-looking number computed from nothing, written to
    // jobs.fit_score, indistinguishable afterwards from a real score.
    if (!fitInputs.fitBrain.trim()) {
      console.error("scoreFit: refusing to score against an empty fit brain");
      return { score: 0, rationale: "", error: emptyBrainRefusal() };
    }
```

`scoreFit`'s callers already treat `score <= 0` as a failure
(`rescoreAllInner`) and read `error` by presence, so nothing downstream changes.

- [ ] **Step 4: Run everything**

Run: `npm run build && npm test`
Expected: PASS. **Watch the three fit-prompt fixtures** — they render from
`FIXTURE_BRAIN`, not `DEFAULT_FIT_BRAIN`, so emptying the default must not move
them. If one moves, something reads the default that should not.

- [ ] **Step 5: Commit**

```bash
git add lib/search-criteria.ts lib/search-criteria.test.ts \
        app/actions/parse-role.ts app/actions/parse-role-empty-brain.test.ts
git commit -m "feat: an empty fit brain refuses the search and the score"
```

---

## Task 7: The onboarding generation prompt

**Files:**
- Create: `lib/onboarding-prompt.ts`, `lib/onboarding-prompt.test.ts`
- Create: `lib/__fixtures__/onboarding-prompt.questions.txt`, `lib/__fixtures__/onboarding-prompt.resume.txt`, `lib/__fixtures__/onboarding-prompt-inputs.ts`

**Interfaces:**
- Consumes: `OnboardingAnswers`, `Profile` from `@/lib/profile`.
- Produces:
  - `const ONBOARDING_SYSTEM: string`
  - `function buildOnboardingPrompt(answers: OnboardingAnswers): string`
  - `const RESUME_MAX_CHARS = 20000`
  - `function truncateResume(text: string): { text: string; truncated: boolean }`
  - `type GeneratedProfile = Omit<Profile, "answers">`

The prompt asks for **exactly the profile's generated fields**, one per key, and
says what each is for in the app's own words — the model writes a fit brain that
`buildFitPrompt` will paste under `CANDIDATE:`, so it must be told that.

**Fixtures, not just unit assertions**, in the manner of the fit-prompt ones:
the prompt's text is what determines whether the generation is any good, and a
reworded instruction should show up as a diff in a rendered file rather than
only inside a builder test. `lib/__fixtures__/onboarding-prompt-inputs.ts` holds
the two answer sets both the test and the regeneration command read, so they
cannot drift.

- [ ] **Step 1: Write the fixture inputs**

Create `lib/__fixtures__/onboarding-prompt-inputs.ts`:

```ts
// The inputs the checked-in onboarding-prompt fixtures were rendered from.
// Shared by lib/onboarding-prompt.test.ts and the regeneration command
// documented there, so the two cannot drift — the same arrangement
// fit-prompt-inputs.ts has.
//
// Deliberately NOT a GTM profile: these fixtures are the one place in the repo
// where a reader can see what the flow does for someone who is not the previous
// user, and a GTM example would hide exactly the failure the fixtures exist to
// expose.

import type { OnboardingAnswers } from "@/lib/profile";

export const FIXTURE_QUESTIONS: OnboardingAnswers = {
  mode: "questions",
  current: "Senior mechanical engineer at a medical device manufacturer, six years designing surgical instrument mechanisms in SolidWorks with FEA in ANSYS.",
  wanted: "Principal or staff design engineer, ideally somewhere I own a product line end to end rather than one subassembly.",
  where: "Denver or remote; I would relocate for the right role in the Front Range.",
  dealbreakers: "No defence work, and nothing requiring five days on site.",
  resume: "",
};

export const FIXTURE_RESUME: OnboardingAnswers = {
  mode: "resume",
  current: "",
  wanted: "A charge nurse or nurse manager role — I want to run a unit rather than take a full patient load.",
  where: "Colorado Springs, in person.",
  dealbreakers: "No night shifts.",
  resume: "REGISTERED NURSE — 9 years, med-surg and step-down. BSN, University of Colorado. ACLS, PALS. Charge nurse on rotation since 2023; precepted 11 new graduates.",
};
```

- [ ] **Step 2: Write the failing test**

Create `lib/onboarding-prompt.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  ONBOARDING_SYSTEM,
  RESUME_MAX_CHARS,
  buildOnboardingPrompt,
  truncateResume,
} from "./onboarding-prompt";
import { FIXTURE_QUESTIONS, FIXTURE_RESUME } from "./__fixtures__/onboarding-prompt-inputs";
import { DEFAULT_PROFILE } from "./profile";

/**
 * Regenerate the fixtures with:
 *
 *   npx tsx -e 'import {writeFileSync} from "node:fs";
 *     import {buildOnboardingPrompt} from "./lib/onboarding-prompt";
 *     import {FIXTURE_QUESTIONS, FIXTURE_RESUME} from "./lib/__fixtures__/onboarding-prompt-inputs";
 *     writeFileSync("lib/__fixtures__/onboarding-prompt.questions.txt", buildOnboardingPrompt(FIXTURE_QUESTIONS));
 *     writeFileSync("lib/__fixtures__/onboarding-prompt.resume.txt", buildOnboardingPrompt(FIXTURE_RESUME));'
 *
 * READ THE RENDERED DIFF in the same commit. Regeneration blesses whatever the
 * code currently emits, so a commit that touches only a fixture is a red flag.
 */
const read = (name: string) =>
  readFileSync(path.join(__dirname, "__fixtures__", name), "utf8");

describe("the rendered onboarding prompt, against its fixture", () => {
  test("the questions path matches onboarding-prompt.questions.txt exactly", () => {
    expect(buildOnboardingPrompt(FIXTURE_QUESTIONS)).toBe(read("onboarding-prompt.questions.txt"));
  });

  test("the résumé path matches onboarding-prompt.resume.txt exactly", () => {
    expect(buildOnboardingPrompt(FIXTURE_RESUME)).toBe(read("onboarding-prompt.resume.txt"));
  });
});

describe("what the prompt asks for", () => {
  test("names every generated profile field, so nothing arrives undefined", () => {
    const prompt = buildOnboardingPrompt(FIXTURE_QUESTIONS);
    for (const key of [
      "fitBrain",
      "weakFitTail",
      "moderateTail",
      "strongTail",
      "titleScope",
      "domainBonus",
      "searchSubject",
      "querySubject",
      "stackFamilyIntro",
      "candidatePersona",
      "buildingConcept",
      "buildingUpside",
      "hiringSignal",
      "toolsAreWeak",
      "titles",
      "locations",
      "stackTerms",
      "locationRule",
    ]) {
      expect(prompt, `${key} is never asked for`).toContain(key);
    }
  });

  test("states the two-word / four-word distinction the two subjects need", () => {
    const prompt = buildOnboardingPrompt(FIXTURE_QUESTIONS);
    expect(prompt).toContain("two or three words");
  });

  test("carries no GTM vocabulary of its own", () => {
    // The generation prompt is the one place a stray example would steer every
    // profile the app ever writes back toward one career.
    const prompt = buildOnboardingPrompt(FIXTURE_RESUME);
    expect(prompt).not.toContain(DEFAULT_PROFILE.searchSubject);
    expect(prompt).not.toContain("RevOps");
    expect(prompt).not.toContain("Salesforce");
    expect(ONBOARDING_SYSTEM).not.toContain("RevOps");
  });

  test("the answers reach the prompt verbatim", () => {
    const prompt = buildOnboardingPrompt(FIXTURE_QUESTIONS);
    expect(prompt).toContain(FIXTURE_QUESTIONS.current);
    expect(prompt).toContain(FIXTURE_QUESTIONS.dealbreakers);
  });

  test("the résumé path sends the résumé and still asks what they want next", () => {
    const prompt = buildOnboardingPrompt(FIXTURE_RESUME);
    expect(prompt).toContain("REGISTERED NURSE");
    // A résumé says where you have BEEN, not where you are going.
    expect(prompt).toContain(FIXTURE_RESUME.wanted);
  });
});

describe("truncateResume", () => {
  test("leaves a normal résumé alone", () => {
    expect(truncateResume("short")).toEqual({ text: "short", truncated: false });
  });

  test("cuts an over-long one and SAYS it cut", () => {
    const long = "x".repeat(RESUME_MAX_CHARS + 1000);
    const out = truncateResume(long);
    expect(out.text.length).toBe(RESUME_MAX_CHARS);
    expect(out.truncated).toBe(true);
  });
});
```

- [ ] **Step 3: Run and confirm failure**

Run: `npx vitest run lib/onboarding-prompt.test.ts`
Expected: FAIL — module unresolved.

- [ ] **Step 4: Write `lib/onboarding-prompt.ts`**

```ts
// The prompt that turns a few sentences (or a pasted résumé) into a career
// profile.
//
// PURE, and pinned by rendered fixtures, for the reason lib/fit-prompt.ts is:
// app/actions/onboarding.ts is "use server", which forbids non-async exports,
// so nothing in it can be exported pure or reached from a test. The text below
// decides what every prompt in the app will say for this user, so a reworded
// instruction has to show up as a diff in a rendered file rather than only
// inside a builder test.
//
// NOTHING HERE MAY BE LOGGED. The answers carry a résumé — the most sensitive
// thing this app stores. This codebase logs prompts and query lists liberally;
// the onboarding prompt is the documented exception. See app/actions/onboarding.ts.

import type { OnboardingAnswers, Profile } from "@/lib/profile";

/** Everything generation produces. `answers` is the input, not an output. */
export type GeneratedProfile = Omit<Profile, "answers"> & {
  /** Seeds the criteria rows too, so onboarding writes one coherent set. */
  titles: string[];
  locations: string[];
  stackTerms: string[];
  locationRule: string;
};

/**
 * The résumé length cap.
 *
 * Roughly five pages of plain text. Anything longer is truncated with the fact
 * reported to the user rather than silently: the résumé rides into a billed
 * call, and an unbounded paste is an unbounded bill.
 */
export const RESUME_MAX_CHARS = 20000;

export function truncateResume(text: string): { text: string; truncated: boolean } {
  return text.length > RESUME_MAX_CHARS
    ? { text: text.slice(0, RESUME_MAX_CHARS), truncated: true }
    : { text, truncated: false };
}

export const ONBOARDING_SYSTEM =
  "You are helping configure a job-search tool for one person, in whatever field they work in. " +
  "You will be given what they told us about themselves and what they want next. " +
  "Return ONLY valid JSON, no markdown, no preamble. " +
  "Never assume a field: a machinist, a nurse, a paralegal and a software engineer must each get " +
  "vocabulary drawn from their own trade and from nothing else.";

const FIELD_GUIDE = `
- fitBrain (string): a description of this person, written in the third person, as bullet points beginning with "- ". It is pasted verbatim under the heading CANDIDATE into a prompt that scores every job posting they see from 1 to 5, so it must state background, depth, strengths, weaker fits, what they are looking for, and where they are. Aim for 1,500-2,500 characters.
- weakFitTail (string): completes the sentence "2 = Weak fit — ". What a weak-but-not-hopeless posting looks like FOR THIS PERSON. Never empty.
- moderateTail (string): completes "3 = Moderate fit — ". Never empty.
- strongTail (string): completes "4 = Strong fit — ". Never empty.
- titleScope (string): bullet lines beginning with "- " explaining how seniority READS in this field: which titles are leadership, which are senior individual contributor, which title words signal a direct match, and which signal a role too narrow to score well. No heading — the app adds one. Empty string if this field has no meaningful title ladder.
- domainBonus (string): an OPTIONAL scoring rule for a specific kind of opportunity this person would want disproportionately, with its own heading line and its conditions. Empty string when there is no such rule — that is a normal answer, not a failure.
- searchSubject (string): how to name this field in a SENTENCE, e.g. "mechanical design and manufacturing engineering". Reads inside "Search for open ___ roles at Acme."
- querySubject (string): how to name the same field inside a SEARCH ENGINE QUERY. Two or three words, e.g. "mechanical engineering". A query is not a sentence: a longer phrase makes it worse.
- stackFamilyIntro (string): one sentence introducing a list of tool-based searches, naming two or three job titles in this field that a title search would MISS. Must end with the words "Use these searches".
- candidatePersona (string): a short noun phrase naming what this person is, e.g. "senior mechanical design engineer". Used inside "1 sentence on why a ___ might fit".
- buildingConcept (string): a gerund phrase naming the hands-on work this person wants to be doing, e.g. "designing mechanisms and running tolerance analysis".
- buildingUpside (string): the same idea as a compressed noun phrase describing what a narrow role would LACK, e.g. "design ownership". It is spliced after the words "with no ".
- hiringSignal (object): { name, sources (array of strings), qualifier, hasRecency (boolean), extraFields (array of strings) } — a PUBLIC EVENT OR PROPERTY that predicts an employer in this field is about to hire, plus where such news is published. Set hasRecency true when it is an event with a date (a funding round, a contract award, a plant opening) and false when it is a standing property (holding a certain licence, operating a certain facility).
- toolsAreWeak (boolean): true when searching by tool name would return mostly noise in this field.
- titles (array of strings): 8-15 exact job titles to search for.
- locations (array of strings): the place terms to search, including "remote" when they want it.
- stackTerms (array of strings): the tools of the trade whose names appear in postings for this work.
- locationRule (string): a sentence telling a search which locations to include and which to exclude, based on where they said they will work.`;

export function buildOnboardingPrompt(answers: OnboardingAnswers): string {
  const about =
    answers.mode === "resume"
      ? `Their résumé:\n"""\n${answers.resume}\n"""`
      : `What they do now: ${answers.current}`;

  return `Configure this job-search tool for one person.

${about}

What they want next: ${answers.wanted}
Where they will work: ${answers.where}
What rules a job out for them: ${answers.dealbreakers}

Return a JSON object with these exact keys:
${FIELD_GUIDE}

Every string must be written in the vocabulary of THIS person's field. Do not import terms from any other industry. Return ONLY the JSON object.`;
}
```

- [ ] **Step 5: Render the fixtures and READ THEM**

Run the regeneration command in the test's docblock, then open both `.txt`
files and read them as a stranger in that trade would. This is the one step
that cannot be automated: the fixtures are the deliverable here, not the
builder.

- [ ] **Step 6: Run and commit**

```bash
npx vitest run lib/onboarding-prompt.test.ts
npm run build && npm test
git add lib/onboarding-prompt.ts lib/onboarding-prompt.test.ts lib/__fixtures__/onboarding-prompt*
git commit -m "feat: the onboarding generation prompt, pinned by rendered fixtures"
```

---

## Task 8: The onboarding actions

**Files:**
- Create: `app/actions/onboarding.ts`
- Create: `app/actions/onboarding.test.ts`
- Modify: `lib/settings-effects.ts` — **no change expected**; the task verifies that

**Interfaces:**
- Consumes: `buildOnboardingPrompt`, `ONBOARDING_SYSTEM`, `truncateResume`, `type GeneratedProfile` (Task 7); `resolveProfile`, `DEFAULT_PROFILE` (Task 1); `profileFrom`, `writeProfile`, `writeOnboardedAt`, `onboardedAtFrom` (Task 2); `withBudget`, `requireActor`, `callStructured`, `parseJson`, `tenantTransaction`, `describeWriteFailure`.
- Produces:
  - `async function getOnboardingState(): Promise<{ answers: OnboardingAnswers; onboardedAt: string | null; hasKey: boolean; error?: string }>`
  - `async function saveAnswers(answers: OnboardingAnswers): Promise<{ error?: string }>`
  - `async function generateProfile(answers: OnboardingAnswers): Promise<{ profile?: GeneratedProfile; capped?: string; error?: string }>`
  - `async function saveProfile(profile: Profile & GeneratedProfile): Promise<{ error?: string }>`
  - `async function clearAnswers(): Promise<{ error?: string }>`

**Five rules this action file must follow, each with its reason:**

1. **`generateProfile` is wrapped in `withBudget`.** It calls Claude.
   `app/actions/parse-role.ts` documents having shipped the unwrapped version
   once, billing the platform key uncapped and unrecorded.
2. **A `capped` result is a REQUIREMENT, not a failure**, and is returned on
   its own key so the UI can render `needsKeyMessage()` with the key field
   attached rather than as "something went wrong". `lib/metered.ts:125`
   refuses before `fn` runs when `tier === "none"`, which is every brand-new
   tenant.
3. **`answers` persist BEFORE generation, not at Finish.** They cost nothing to
   store and are the whole input to a billed call; a refresh, a closed laptop or
   a timeout must not lose them.
4. **`saveProfile` writes every key in ONE `tenantTransaction`.** A tenant with
   titles but no fit brain would pass the `onboarded_at` gate and then score
   against nothing. That block stays short and contains **no Claude call** —
   `lib/supabase.ts`'s own rule for the function.
5. **A RE-RUN routes through the same effects a save triggers.** Writing with
   `tenantTransaction` alone bypasses `cachesToClear` (leaving `role_searches`
   and `discovered_roles` full of the previous career), the `criteria_changed_at`
   stamp, and the rescore offer — producing a `jobs` table scored half against
   career A and half against career B with nothing on screen distinguishing
   them. `AFFECTS_CRAWL` is `[titles, locationRule]`, both of which onboarding
   writes, so the stamp is always due on a re-run.

**Nothing here is logged.** Log the fact of a generation and its outcome, never
the prompt, the answers or the résumé.

- [ ] **Step 1: Write the failing test**

`app/actions/onboarding.test.ts` — following the precedent in
`app/actions/settings.test.ts`, test only the parts that return before touching
the database or Claude, plus the pure helpers:

```ts
import { describe, expect, test } from "vitest";
import { answersAreComplete, cachesOnboardingClears, generationFailure } from "./onboarding";
import { DEFAULT_PROFILE } from "@/lib/profile";

describe("answersAreComplete", () => {
  test("the questions path needs what it asks for", () => {
    expect(answersAreComplete({ ...DEFAULT_PROFILE.answers, mode: "questions" })).toBe(false);
    expect(
      answersAreComplete({
        mode: "questions",
        current: "Machinist",
        wanted: "CNC programmer",
        where: "Denver",
        dealbreakers: "",
        resume: "",
      })
    ).toBe(true);
  });

  test("dealbreakers may be empty — 'nothing rules a job out' is an answer", () => {
    expect(
      answersAreComplete({
        mode: "questions",
        current: "Machinist",
        wanted: "CNC programmer",
        where: "Denver",
        dealbreakers: "",
        resume: "",
      })
    ).toBe(true);
  });

  test("the résumé path needs a résumé AND what they want next", () => {
    expect(
      answersAreComplete({
        mode: "resume",
        current: "",
        wanted: "",
        where: "Denver",
        dealbreakers: "",
        resume: "a résumé",
      })
    ).toBe(false);
    expect(
      answersAreComplete({
        mode: "resume",
        current: "",
        wanted: "Charge nurse",
        where: "Denver",
        dealbreakers: "",
        resume: "a résumé",
      })
    ).toBe(true);
  });
});

describe("cachesOnboardingClears", () => {
  test("clears every cache the criteria keys it writes would clear", () => {
    // Derived from lib/settings-effects.ts, never hand-listed: a new cache
    // added to CACHES_TO_CLEAR must reach onboarding too, and a hand-copy is
    // how the two drift.
    expect(cachesOnboardingClears()).toEqual(
      expect.arrayContaining(["role_searches", "discovered_roles"])
    );
  });

  test("never clears jobs — that is the user's pipeline, not a cache", () => {
    expect(cachesOnboardingClears()).not.toContain("jobs");
  });
});

describe("generationFailure", () => {
  test("does not name the database — the failure is Claude or the parse", () => {
    // UNDESCRIBED_DB_ERROR names the database and would be a false sentence
    // here. Same ruling scoreFit's catch follows.
    expect(generationFailure()).not.toMatch(/database/i);
    expect(generationFailure().length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run app/actions/onboarding.test.ts`
Expected: FAIL — module unresolved.

- [ ] **Step 3: Write `app/actions/onboarding.ts`**

```ts
"use server";

import { requireActor } from "@/lib/require-actor";
import { withBudget } from "@/lib/metered";
import { resolveTenantId } from "@/lib/tenant";

import { callStructured, parseJson } from "@/lib/model-call";
import {
  ONBOARDING_SYSTEM,
  buildOnboardingPrompt,
  truncateResume,
  type GeneratedProfile,
} from "@/lib/onboarding-prompt";
import {
  DEFAULT_PROFILE,
  resolveProfile,
  type OnboardingAnswers,
  type Profile,
} from "@/lib/profile";
import { validateList } from "@/lib/criteria-validation";
import { CACHES_TO_CLEAR } from "@/lib/settings-effects";
import {
  CRITERIA_CHANGED_AT_KEY,
  ONBOARDED_AT_KEY,
  PROFILE_KEY,
  SETTING_KEYS,
  describeWriteFailure,
  onboardedAtFrom,
  profileFrom,
  readAllSettingsResult,
  writeProfile,
} from "@/lib/settings-store";
import { rawQuery, tenantTransaction } from "@/lib/supabase";

/**
 * Whether the answers are enough to generate from.
 *
 * `dealbreakers` is NOT required: "nothing rules a job out" is a real answer,
 * and forcing a sentence there produces a made-up constraint that then scores
 * every role for the life of the profile.
 *
 * Pure and exported so it can be tested — nothing else in this module can be.
 */
export async function answersAreComplete(answers: OnboardingAnswers): Promise<boolean> {
  const has = (s: string) => s.trim().length > 0;
  if (!has(answers.wanted) || !has(answers.where)) return false;
  return answers.mode === "resume" ? has(answers.resume) : has(answers.current);
}

/**
 * The cache tables a completed onboarding must clear, DERIVED from
 * lib/settings-effects.ts rather than listed here.
 *
 * Onboarding writes titles, locations, stackTerms, locationRule and fitBrain in
 * one transaction, so it invalidates the union of what saving each of them
 * would invalidate. Hand-listing the union is how it drifts from the map that
 * decides — and the consequence of drift is a role_searches cache full of the
 * PREVIOUS career, served to a user who just told the app they do something
 * else.
 */
export async function cachesOnboardingClears(): Promise<string[]> {
  const keys = [
    SETTING_KEYS.titles,
    SETTING_KEYS.locations,
    SETTING_KEYS.stackTerms,
    SETTING_KEYS.locationRule,
    SETTING_KEYS.fitBrain,
  ];
  return Array.from(new Set(keys.flatMap((k) => CACHES_TO_CLEAR[k])));
}

/**
 * What to say when generation fails.
 *
 * Deliberately NOT describeWriteFailure / UNDESCRIBED_DB_ERROR: the failure
 * here is the model or the JSON parse, and a sentence naming the database
 * would be false. Same ruling scoreFit's catch already follows. Non-empty on
 * every path, so the caller's presence check still separates failure from
 * success.
 */
export async function generationFailure(): Promise<string> {
  return (
    "Could not build your profile from those answers. Try rephrasing what you " +
    "do and what you want next, then generate again."
  );
}

export async function getOnboardingState(): Promise<{
  answers: OnboardingAnswers;
  onboardedAt: string | null;
  error?: string;
}> {
  await requireActor();
  const { rows, error } = await readAllSettingsResult();
  // Presence, not truthiness. This page decides whether to show a user their
  // own half-finished answers; rendering empty ones because the read failed
  // would silently discard input they already gave.
  if (error !== undefined) {
    return {
      answers: DEFAULT_PROFILE.answers,
      onboardedAt: null,
      error: describeWriteFailure(error, "read your onboarding answers")!,
    };
  }
  return {
    answers: profileFrom(rows).answers,
    onboardedAt: onboardedAtFrom(rows),
  };
}

/**
 * Stores the raw answers, BEFORE the billed call.
 *
 * They cost nothing to store and they are the whole input to a call the user
 * pays for; losing them to a refresh or a timeout means paying twice to answer
 * the same questions. Written into the profile document's `answers` field, so
 * there is still exactly one profile row.
 */
export async function saveAnswers(answers: OnboardingAnswers): Promise<{ error?: string }> {
  await requireActor();
  const { rows, error: readError } = await readAllSettingsResult();
  const described = describeWriteFailure(readError, "read your profile");
  if (described !== undefined) {
    console.error(`onboarding: ${described}`);
    return { error: described };
  }
  const next: Profile = { ...profileFrom(rows), answers: resolveProfile({ answers }).answers };
  const { error } = await writeProfile(next);
  const wrote = describeWriteFailure(error, "save your answers");
  if (wrote !== undefined) {
    console.error(`onboarding: ${wrote}`);
    return { error: wrote };
  }
  return {};
}

/**
 * Metered. It calls Claude, so it is wrapped — an unwrapped call bills the
 * platform key uncapped and unrecorded, the defect app/actions/parse-role.ts
 * documents having already shipped once.
 *
 * `capped` is returned on its OWN key rather than folded into `error`. A cap
 * here is nearly always "this tenant has no API key yet" (lib/metered.ts
 * refuses before fn runs when tier is "none"), which is a REQUIREMENT the UI
 * renders with the key field attached — not a failure.
 */
export async function generateProfile(
  answers: OnboardingAnswers
): Promise<{ profile?: GeneratedProfile; capped?: string; error?: string }> {
  const actor = await requireActor();
  const budget = await withBudget({
    action: "onboarding",
    estimateCents: 5,
    isAdmin: actor.isAdmin,
    fn: () => generateProfileInner(answers),
  });
  if (budget.capped) return { capped: budget.capped };
  if (budget.error !== undefined) return { error: budget.error };
  return budget.result!;
}

async function generateProfileInner(
  answers: OnboardingAnswers
): Promise<{ profile?: GeneratedProfile; error?: string }> {
  try {
    const { text, truncated } = truncateResume(answers.resume);
    if (truncated) {
      console.log("onboarding: résumé truncated to the length cap before generating");
    }
    const raw = await callStructured({
      system: ONBOARDING_SYSTEM,
      // NOT LOGGED, here or anywhere. The prompt carries the user's résumé —
      // the most sensitive thing this app stores. Every other search path in
      // this repo logs its prompt or its query list; this one is the
      // documented exception.
      prompt: buildOnboardingPrompt({ ...answers, resume: text }),
      // Generous: the fit brain alone is 1,500-2,500 characters and there are
      // eighteen fields. 2000 tokens has truncated a response before the JSON
      // was emitted elsewhere in this app.
      maxTokens: 6000,
    });
    const parsed = parseJson<Record<string, unknown>>(raw);
    // Validated and repaired, NEVER trusted raw. A model that returns prose
    // where a list was asked for must not produce a fit brain that is the word
    // "undefined" — resolveProfile is where that rule lives.
    const repaired = resolveProfile(parsed);
    return {
      profile: {
        ...repaired,
        titles: listOr(parsed.titles, []),
        locations: listOr(parsed.locations, []),
        stackTerms: listOr(parsed.stackTerms, []),
        locationRule: typeof parsed.locationRule === "string" ? parsed.locationRule : "",
      },
    };
  } catch (err) {
    console.error("onboarding: generation failed:", err);
    return { error: await generationFailure() };
  }
}

function listOr(v: unknown, fallback: string[]): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : fallback;
}
```

Then `saveProfile` — the transactional finish. It writes seven rows, then runs
the side effects **outside** the transaction:

```ts
/**
 * The finish step: every key at once, or none.
 *
 * ONE tenantTransaction, because a partial profile is worse than no profile —
 * a tenant with titles but no fit brain passes the onboarded_at gate and then
 * scores every role against nothing. The block is short and contains no Claude
 * call, per tenantTransaction's own documented rule.
 *
 * The side effects run AFTER the commit, deliberately: clearing a cache inside
 * the transaction would roll back on a failure that has already been reported,
 * and a revalidatePath inside a database transaction is meaningless.
 *
 * A RE-RUN takes the same path. Writing the rows without these effects leaves
 * role_searches and discovered_roles full of the previous career, skips the
 * criteria_changed_at stamp the crawler's closure debounce reads, and skips
 * the rescore offer — producing a jobs table scored half against one career
 * and half against another with nothing on screen distinguishing them.
 */
export async function saveProfile(
  profile: Profile & { titles: string[]; locations: string[]; stackTerms: string[]; locationRule: string }
): Promise<{ error?: string }> {
  await requireActor();

  // Blocked at the action as well as at the screen. An empty fit brain is the
  // one field whose absence is not recoverable by editing later: every role
  // ingested in the meantime is scored against nothing.
  if (!profile.fitBrain.trim()) {
    return { error: "Your profile needs a description of you before it can be saved." };
  }
  for (const [items, label] of [
    [profile.titles, "Target titles"],
    [profile.locations, "Location terms"],
  ] as const) {
    const check = validateList(items, label);
    if (!check.ok) return { error: check.error };
  }

  const tenantId = await resolveTenantId();
  const clean = resolveProfile(profile);
  const now = new Date().toISOString();

  try {
    await tenantTransaction(tenantId, async (q) => {
      const put = (key: string, value: unknown) =>
        q(
          `insert into app_settings (tenant_id, key, value, updated_at)
           values ($1, $2, $3::jsonb, now())
           on conflict (tenant_id, key) do update set value = excluded.value, updated_at = now()`,
          [tenantId, key, JSON.stringify(value)]
        );
      await put(PROFILE_KEY, clean);
      await put(SETTING_KEYS.titles, profile.titles);
      await put(SETTING_KEYS.locations, profile.locations);
      await put(SETTING_KEYS.stackTerms, profile.stackTerms);
      await put(SETTING_KEYS.locationRule, profile.locationRule);
      // The fit brain is written to BOTH the profile and its own setting row:
      // /settings edits the row, and scoringInputsFrom reads the profile first
      // and falls back to the row. Writing only one would make the settings
      // page show a brain the scorer does not use, or the reverse.
      await put(SETTING_KEYS.fitBrain, clean.fitBrain);
      // CRITERIA_CHANGED_AT_KEY, never the literal "criteria_changed_at". The
      // constant exists precisely so a writer and its reader cannot drift on
      // the spelling, and a drifted key here is a silent no-op: the crawler's
      // stale-posting debounce would never see the change.
      await put(CRITERIA_CHANGED_AT_KEY, now);
      await put(ONBOARDED_AT_KEY, now);
    });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    console.error(`onboarding: could not save the profile — ${why}`);
    return { error: describeWriteFailure(why, "save your profile")! };
  }

  // After the commit. Non-fatal: the profile is already stored, and a surviving
  // cache serves stale results until it expires, which is worse than fresh but
  // far better than telling the user the save failed when it did not.
  for (const table of await cachesOnboardingClears()) {
    const { error } = await rawQuery(
      `delete from ${table} where tenant_id = $1`,
      [tenantId],
      tenantId
    );
    if (error) console.error(`onboarding: could not clear ${table} — ${error.message}`);
  }
  return {};
}

/** Forgets the stored answers, résumé included, leaving the profile itself. */
export async function clearAnswers(): Promise<{ error?: string }> {
  await requireActor();
  const { rows, error } = await readAllSettingsResult();
  const described = describeWriteFailure(error, "read your profile");
  if (described !== undefined) return { error: described };
  const { error: writeError } = await writeProfile({
    ...profileFrom(rows),
    answers: DEFAULT_PROFILE.answers,
  });
  const wrote = describeWriteFailure(writeError, "clear your answers");
  return wrote === undefined ? {} : { error: wrote };
}
```

`saveAnswers` and `clearAnswers` use `writeProfile` from
`lib/settings-store.ts` — the single upsert next to the key. `saveProfile` does
NOT, because its whole point is that seven rows land together or none do, and
`writeProfile` takes its own connection. Do not add a second upsert helper.

**Note on `"use server"`:** every export must be `async`. That is why
`answersAreComplete`, `cachesOnboardingClears` and `generationFailure` are
declared `async` above even though their bodies are synchronous, and why the
test `await`s them. If that reads badly, move all three into a pure
`lib/onboarding-rules.ts` and test them there — that is the repo's usual
answer and the better one if the list grows.

- [ ] **Step 4: Confirm `lib/settings-effects.ts` needs no change**

Run: `npx vitest run lib/settings-effects.test.ts`
Expected: PASS, unedited. Neither `PROFILE_KEY` nor `ONBOARDED_AT_KEY` is a
`SettingKey`, so neither `CACHES_TO_CLEAR` nor `PATHS_TO_REVALIDATE` — both
typed `Record<SettingKey, string[]>` — can hold it. This is the same conclusion
the status work reached, and the compile is the proof.

- [ ] **Step 5: Run and commit**

```bash
npx vitest run app/actions/onboarding.test.ts
npm run build && npm test
git add app/actions/onboarding.ts app/actions/onboarding.test.ts
git commit -m "feat: onboarding actions — answers, metered generation, transactional finish"
```

---

## Task 9: The gate — a page redirect that cannot recurse

**Files:**
- Modify: `lib/require-actor.ts`
- Modify: `app/admin/page.tsx`
- Create: `lib/onboarding-gate.test.ts`

**Interfaces:**
- Consumes: `readOnboardedAtFor(tenantId)` (Task 2).
- Produces:
  - `function onboardingRedirect(input: { actor: Actor; onboardedAt: string | null; allowUnonboarded: boolean }): string | null` — pure, exported, testable
  - `async function requireActorPage(): Promise<Actor>` — now redirects
  - `async function requireAdminPage(): Promise<Actor>` — the `/admin` opt-out

**Two mechanisms, each doing what it is good at.** Pages get a redirect, for the
user experience. **Actions get nothing at all** — an un-onboarded tenant has no
stored criteria and `DEFAULT_FIT_BRAIN` is `""`, so a search called directly
refuses through `emptySearchReason` (Task 6). The empty defaults ARE the
action-level gate, and they fail in the direction this codebase always chooses:
loudly, with a reason. A guard can be forgotten on a new action; empty criteria
protect every path that has not been written yet.

**Not middleware** — it runs on Edge and cannot reach Postgres, which is why the
password gate is a cookie comparison. **And not `requireActor()`** — revision 2
put it there and it recursed: `resolveTenantId()` is `(await
requireActor()).tenantId`, and `readAllSettingsResult` calls it twice, so a
branch inside `requireActor()` that reads `app_settings` calls itself unbounded.

**`isPlatform()` still matters.** The cron crawler runs as `PLATFORM_ACTOR` with
no session, so it never reaches `requireActorPage()` — verify this by grep
rather than assuming, then leave a comment saying so.

- [ ] **Step 1: Write the failing test**

Create `lib/onboarding-gate.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { onboardingRedirect } from "./require-actor";
import type { Actor } from "./require-actor";

const user: Actor = { userId: "u1", tenantId: "u1", email: "a@b.c", isAdmin: false };
const admin: Actor = { ...user, isAdmin: true };

describe("onboardingRedirect", () => {
  test("active with no stamp goes to /welcome", () => {
    expect(onboardingRedirect({ actor: user, onboardedAt: null, allowUnonboarded: false })).toBe(
      "/welcome"
    );
  });

  test("active with a stamp passes through", () => {
    expect(
      onboardingRedirect({ actor: user, onboardedAt: "2026-08-17T00:00:00.000Z", allowUnonboarded: false })
    ).toBeNull();
  });

  test("an opted-out page passes through regardless", () => {
    // /admin. Without this, a bug in onboarding locks the only admin out of the
    // approval screen — the flow holding the door shut on the one person who
    // could open it.
    expect(onboardingRedirect({ actor: admin, onboardedAt: null, allowUnonboarded: true })).toBeNull();
  });

  test("being an admin is NOT by itself an exemption", () => {
    // The admin is the account that would dogfood this flow. Exempting them by
    // role would leave it untested by the only person who can judge its output.
    expect(onboardingRedirect({ actor: admin, onboardedAt: null, allowUnonboarded: false })).toBe(
      "/welcome"
    );
  });

  test("an empty-string stamp is NOT a stamp", () => {
    expect(onboardingRedirect({ actor: user, onboardedAt: "", allowUnonboarded: false })).toBe(
      "/welcome"
    );
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run lib/onboarding-gate.test.ts`
Expected: FAIL — `onboardingRedirect` is not exported.

- [ ] **Step 3: Edit `lib/require-actor.ts`**

```ts
import { readOnboardedAtFor } from "@/lib/settings-store";

/**
 * Where an active tenant should be sent instead of the page they asked for, or
 * null to let them through.
 *
 * Pure and exported so the rule is testable: requireActorPage itself reads the
 * session and the database and can be reached from no test in this repo.
 *
 * `allowUnonboarded` is a PER-CALL-SITE opt-out, not a route list — this
 * function does not know which route called it, and revision 2 of the design
 * assumed a mechanism that does not exist. /admin is the only caller that
 * passes true.
 */
export function onboardingRedirect(input: {
  actor: Actor;
  onboardedAt: string | null;
  allowUnonboarded: boolean;
}): string | null {
  if (input.allowUnonboarded) return null;
  // Empty string is not a stamp: writeOnboardedAt always writes an ISO string,
  // so an empty one is a hand-edit or a bad write, and letting it through is
  // how a tenant reaches /discover with no criteria at all.
  return input.onboardedAt && input.onboardedAt.length > 0 ? null : "/welcome";
}

/**
 * For PAGES. Sends anyone without an allowed session to /signin, which doubles
 * as the waitlist screen for a pending user — and anyone who has not finished
 * onboarding to /welcome.
 *
 * The stamp is read through readOnboardedAtFor, which takes actor.tenantId
 * EXPLICITLY and never calls resolveTenantId. That is not a style choice:
 * resolveTenantId is `(await requireActor()).tenantId`, so a reader that
 * resolved its own tenant would call requireActor() from inside this flow,
 * unbounded. See the note on readOnboardedAtFor.
 *
 * Costs one extra query per page render on five force-dynamic pages. The cron
 * crawler is unaffected — it has no session and never reaches a page.
 */
export async function requireActorPage(opts?: { allowUnonboarded?: boolean }): Promise<Actor> {
  const actor = await readActor();
  if (!actor) redirect("/signin");
  const target = onboardingRedirect({
    actor,
    onboardedAt: await readOnboardedAtFor(actor.tenantId),
    allowUnonboarded: opts?.allowUnonboarded === true,
  });
  if (target) redirect(target);
  return actor;
}

/**
 * For /admin, which opts OUT of the onboarding gate.
 *
 * A bug in onboarding must not lock the only admin out of the approval screen.
 * Admin ACTIONS need nothing equivalent: app/actions/admin.ts reads no criteria
 * and scores nothing, so the empty-criteria protection is irrelevant to it and
 * there is no second lockout behind the Approve button. Verified by grep, not
 * by assumption.
 *
 * Deliberately NOT an isAdmin exemption inside requireActorPage: the admin is
 * the account that would dogfood this flow, and exempting them by role would
 * leave it untested by the one person able to judge whether its output is any
 * good.
 */
export async function requireAdminPage(): Promise<Actor> {
  return requireActorPage({ allowUnonboarded: true });
}
```

`app/admin/page.tsx` swaps `requireActorPage()` for `requireAdminPage()` and
keeps its own `if (!actor.isAdmin) redirect("/discover")`.

- [ ] **Step 4: Verify the crawler is unaffected**

Run: `grep -rn "requireActorPage\|requireAdminPage" app lib`
Expected: only the five page components and `lib/require-actor.ts`. Nothing in
`app/api/cron/`, `lib/crawler.ts` or `app/actions/`. Record what you found; if
a cron path does reach it, stop and re-plan.

- [ ] **Step 5: Run and commit**

```bash
npx vitest run lib/onboarding-gate.test.ts
npm run build && npm test
git add lib/require-actor.ts app/admin/page.tsx lib/onboarding-gate.test.ts
git commit -m "feat: un-onboarded tenants are redirected to /welcome"
```

---

## Task 10: `/welcome` and the onboarding component

**Files:**
- Create: `app/welcome/page.tsx`
- Create: `components/Onboarding.tsx`

`vitest` here is `environment: "node"` with no jsdom, so **the component is not
unit-testable and none of its logic may live in it** — everything decidable
belongs in `lib/profile.ts` or `lib/onboarding-prompt.ts`, where Tasks 1 and 7
already put it. The component wires, renders and calls.

**The five steps, and what each one is for:**

**Step 0 — the API key.** Before any question. `lib/metered.ts` refuses before
`fn` runs when `tier === "none"`, and a brand-new tenant has no
`tenant_api_keys` row, so without this the only billed step in the flow is
unreachable for every real new user. Reuse `components/ApiKeyPanel.tsx` inline
— it already renders in both states with the right copy. **Skipped when a key
is already stored**, which is why `getApiKeyStatus()` is read first.

**Step 1 — the door.** Two radio choices: answer a few questions, or paste a
résumé.

**Step 2 — the questions, or the paste.** The résumé path is a different Step 2,
not a second pipeline: it asks for the résumé **plus** what they want next,
because a résumé says where you have been, not where you are going. The paste
screen carries the privacy sentence: *your résumé goes to your own model
provider on your own API key; it is stored so you can regenerate without
pasting again; you can clear it at any time.* Wire that last clause to
`clearAnswers`.

**`saveAnswers` fires on leaving Step 2**, before Step 3. Do not wait for
Finish.

**Step 3 — one billed call.** `generateProfile`. A `capped` result renders as a
**requirement with the key field attached** — `needsKeyMessage()` is already
written as a sentence for exactly this — never as "something went wrong".

**Step 4 — review and edit.** The load-bearing screen. Layout per the spec:

- Job titles to search for — one per line, the same control `/settings` uses
- Where · Tools of the trade — side by side
- A visually distinct block headed **THIS IS WHAT SCORES YOUR ROLES**, holding
  the fit brain and the title-scope signals. They are categorically different
  from the search terms above: a wrong search term is visibly missing results,
  a wrong scoring field looks exactly like a correct one.
- Behind a "More" disclosure: `searchSubject`, `querySubject`,
  `stackFamilyIntro`, `candidatePersona`, `buildingConcept`, `buildingUpside`,
  the three clause tails, `domainBonus`, and the hiring signal. These are the
  fields the spec's mock does not show, and they are generated rather than
  asked for — so they must be visible and editable somewhere before first use,
  even if most users never open the panel.
- **A sample score, beside the fields.** "Here is what we understood, edit
  anything that is wrong" over a block of rubric prose gives the user no way to
  judge it — they have never seen the scoring prompt and the only feedback loop
  is fit scores hours later. So Step 4 scores ONE role and shows the score and
  rationale: a wrong fit brain becomes visible as "it scored a shop-floor
  technician job a 4". The sample is a posting the user pastes, or a canned one
  built from their generated titles. Call `scoreFit` with the drafted
  `profileToFitInputs(draft, null)` — it is metered in its own right, so this
  costs one small billed call and needs no new plumbing.
- **An empty fit brain is blocked at this screen**, not discovered later by
  `emptySearchReason`. An empty `titleScope` is fine and omits the block.
- Two buttons: **Start over** (states plainly whether it re-bills — it does, it
  re-runs generation) and **Looks right — finish**. Per-field **regenerate just
  this** is the cheaper path for the common case of one bad field; if you cut
  scope anywhere in this task, cut that and say so.

**Finish** calls `saveProfile`, then `router.push("/discover")`.

`app/welcome/page.tsx`:

```tsx
import Onboarding from "@/components/Onboarding";
import { requireActorPage } from "@/lib/require-actor";

// force-dynamic for the same reason every other page here is: it depends on the
// REQUEST (its session), and a prerendered page would run the auth check once
// at build time against no session.
export const dynamic = "force-dynamic";

/**
 * The one page that opts out of the onboarding gate, because it IS the
 * onboarding. Without the opt-out this page redirects to itself.
 */
export default async function WelcomePage() {
  await requireActorPage({ allowUnonboarded: true });
  return <Onboarding />;
}
```

- [ ] **Step 1: Write `app/welcome/page.tsx`** exactly as above.

- [ ] **Step 2: Write `components/Onboarding.tsx`**

Follow `components/Settings.tsx` for its shape: `"use client"`, `useState` per
draft field, `busy` / `errors` / `notices` records, `Spinner` from `./ui`,
`describeWriteFailure`-style presence checks (`res.error !== undefined`, never
`if (res.error)`) on every action result. Import types only from `lib/` —
`import type { Profile }` — so nothing pulls `pg` into the client bundle;
`lib/profile.ts` is safe to import at runtime because Task 1 kept it clean, and
that is what makes `resolveProfile` reusable for the draft.

- [ ] **Step 3: Verify it builds and the gate loop closes**

Run: `npm run build`
Expected: clean. Then confirm by reading: `/welcome` passes
`allowUnonboarded: true`, so an un-onboarded user lands there and stays.

- [ ] **Step 4: Run the app and walk the flow**

```bash
npm run dev
```
Open `/welcome` and walk every step. The generation call is real and billed.

- [ ] **Step 5: Commit**

```bash
npm run build && npm test
git add app/welcome components/Onboarding.tsx
git commit -m "feat: the /welcome onboarding flow"
```

---

## Task 11: `/settings` edits the profile

**Files:**
- Modify: `components/Settings.tsx`
- Modify: `app/actions/settings.ts` (one new action)
- Modify: `lib/settings-view.ts` (carry the profile)
- Modify: `lib/settings-view.test.ts`

**Interfaces:**
- Produces: `saveProfileFields(patch: Partial<Profile>): Promise<{ error?: string }>` in `app/actions/settings.ts`; `SettingsView` gains `profile: Profile`.

The spec puts editing the profile's *outputs* on `/settings` and re-running the
flow for the *answers*. So: a "How your roles are scored" section holding
`titleScope`, `domainBonus` and the three clause tails, a "How your field is
described" section holding the six search/extraction strings, and a link to
re-run onboarding. The fit brain keeps its existing card and its existing
action — Task 4's precedence (profile first, setting row as fallback) is what
makes that keep working, and `saveProfileFields` must write the profile's
`fitBrain` too when the brain card saves, or the two diverge.

**Relabel** `LABELS.stackTerms` from `"GTM stack terms"` to `"Tools of the
trade"`. The KEY stays `stackTerms` — renaming it is a migration for no
behavioural gain, and `SETTING_KEYS` values must equal `Criteria` field names
or every save becomes a silent no-op.

**Effects.** `saveProfileFields` routes through the same `applySideEffects`
funnel by key for whatever criteria keys it touches. The profile itself is not a
`SettingKey`, so it has no entry in `CACHES_TO_CLEAR` — decide explicitly what a
profile edit invalidates and write the reasoning down: changing `searchSubject`
or `stackFamilyIntro` changes what a search FINDS, so it invalidates
`role_searches` and `discovered_roles`; changing a clause tail or `titleScope`
only re-scores, so it invalidates nothing and offers a rescore instead —
`fitBrainRescoreOffer` in `lib/rescore-progress.ts` is the existing shape for
that offer.

- [ ] **Step 1: Write the failing test** — extend `lib/settings-view.test.ts`:

```ts
  test("the view carries the tenant's profile off the same snapshot", () => {
    const view = buildSettingsView({
      rows: [{ key: PROFILE_KEY, value: { searchSubject: "nursing" } }],
      settingsError: undefined,
      scoredJobCount: 0,
      countError: undefined,
    });
    expect(view.profile.searchSubject).toBe("nursing");
  });

  test("a failed read shows the shipped profile, and the banner explains why", () => {
    const view = buildSettingsView({
      rows: [],
      settingsError: "",
      scoredJobCount: 0,
      countError: undefined,
    });
    expect(view.profile).toEqual(DEFAULT_PROFILE);
    expect(view.error).toBeTruthy();
  });
```

- [ ] **Step 2: Run and confirm failure.** `npx vitest run lib/settings-view.test.ts`

- [ ] **Step 3: Add `profile: profileFrom(input.rows)` to `buildSettingsView`'s return**, with a comment saying it comes off the same snapshot as everything else for the reason the file already gives.

- [ ] **Step 4: Write `saveProfileFields` in `app/actions/settings.ts`**, following `saveCriteriaText`'s shape exactly: `requireActor()`, validate, `writeProfile`, `describeWriteFailure` then `!== undefined`, then the side effects. Document the invalidation decision above in its docblock.

- [ ] **Step 5: Add the two sections to `components/Settings.tsx`** and relabel `stackTerms`.

- [ ] **Step 6: Run and commit**

```bash
npm run build && npm test
git add components/Settings.tsx app/actions/settings.ts lib/settings-view.ts lib/settings-view.test.ts
git commit -m "feat: /settings edits the profile's generated fields"
```

---

## Task 12: Probe the hiring signal before building Discover

**Files:** none. This task produces a decision and a paragraph, not code.

The spec is explicit: *"Run two or three real searches for a non-tech signal and
read what comes back BEFORE committing to the schema. If the signal is not
findable, the honest answer is to hide Discover for that profile rather than
ship a tab that returns noise — and that is a cheaper thing to learn now than
after the redesign."*

- [ ] **Step 1: Run three probes** through the app's own path so the result
  reflects what production would get. Use the Watchlist "Check now" button's
  route or a one-off script through `callWithWebSearch`; do not use a chat
  window, which has different search behaviour.

  Probe A — an event with good coverage: defence contract awards over $50M,
  sources Defense News / GovWin / trade press.
  Probe B — an event with patchier coverage: manufacturing plant expansions and
  new facility openings in a named state.
  Probe C — a standing property rather than an event (`hasRecency: false`): the
  hospital systems in a metro area that hold Magnet designation.

- [ ] **Step 2: Read what comes back** and answer three questions in writing:
  does each probe return real employers rather than articles about the sector;
  is the `signal` string writable as one legible human-readable line for each;
  and does Probe C work at all without a time window.

- [ ] **Step 3: Record the decision** in the design doc under a new heading
  "Hiring-signal probe, 2026-08-__", with the actual outputs quoted. If a probe
  fails, Task 13 changes: Discover is HIDDEN for profiles whose signal did not
  probe well, rather than shipped returning noise. Say which.

**Do not skip this task and do not infer its answer.** The whole Discover
redesign in Task 13 rests on it, and phase 1's costliest defects were all
sentences about behaviour written without checking.

---

## Task 13: Discover runs on the hiring signal

**Files:**
- Create: `lib/hiring-signal-prompt.ts`, `lib/hiring-signal-prompt.test.ts`
- Modify: `app/actions/discover.ts`, `lib/types.ts`, `lib/discovery-windows.ts`, `lib/discovery-windows.test.ts`, `components/Discover.tsx`

**Interfaces:**
- Produces:
  - `function hiringSignalSystem(signal: HiringSignal): string`
  - `function buildHiringSignalPrompt(args: { signal: HiringSignal; criteria: Criteria; period: string | null; focus: string; now?: Date }): string`
  - `Startup` gains `signal: string` and `extras: Record<string, string>`
  - `DateRange` gains `"current"`

Discover is coupled at five layers and revision 2 changed only the first.
All five move:

| Layer | Now |
|---|---|
| System prompt | `hiringSignalSystem(profile.hiringSignal)` |
| User prompt | `buildHiringSignalPrompt(...)` — the qualifier, the source list and the searches all interpolate |
| Result schema | a fixed core (`company`, `tagline`, `careers_url`, `headquarters`, `signal`) plus generated `extras` |
| Time windows | `hasRecency` decides; `"current"` is the window when it is false |
| Cards | render the `signal` string plus extras |

**The `signal` string is what makes the feature legible across domains** —
*"Raised $400M Series D led by a16z"*, *"Won $2.1B USAF sustainment contract"* —
and it reads better than six sparse columns even for the venture case.

**`"current"` and the cache key.** `discovered_startups`' unique key is
`(tenant_id, date_range, search_term)`. Adding a `DateRange` member keeps that
working with no schema change; `extras` is a jsonb field inside the existing
`startups` array, so it needs none either.

**The invariant revision 2 mis-stated.** `lib/discovery-windows.test.ts` asserts
no range is both *pinned and legacy*; `7d` and `30d` are deliberately in BOTH
`FETCHABLE_RANGES` and `PINNED_CHIPS`. Read the test before editing it. Adding
`"current"` must not break the real invariants: every fetchable range is also
charted, nothing sits in two of the mutually-exclusive lists, and the fetchable
set is exactly what one click may bill.

- [ ] **Step 1: Write the failing test** — `lib/hiring-signal-prompt.test.ts`,
  with the same two guarantees the other prompt builders got: byte-identity
  against today's rendered venture prompt when handed `DEFAULT_PROFILE.hiringSignal`
  (so this is a no-op for the existing user), and a handed-value assertion using
  a synthetic signal that checks the synthetic sources and qualifier appear and
  "Series B" / "TechCrunch" do not.

- [ ] **Step 2: Run and confirm failure.**

- [ ] **Step 3: Write `lib/hiring-signal-prompt.ts`.** Take today's two prompt
  strings from `app/actions/discover.ts:14` and `:133` verbatim and replace only
  what the signal supplies. The `period` parameter is `null` when
  `hasRecency` is false, and the prompt then asks for current holders of the
  property rather than for announcements in a window.

- [ ] **Step 4: Widen `Startup` and `DateRange`.** `signal` and `extras` are
  REQUIRED on `Startup` — an optional field would let a row through with
  neither, and `components/Discover.tsx` would render an empty card. Existing
  cached rows have neither: read them defensively in the component (`s.signal ??
  legacySignalFrom(s)`), and write a `legacySignalFrom` helper that composes
  `raised` + `stage` + `lead_investor` into one line so old cache rows still
  read well. Put it in `lib/` with a test.

- [ ] **Step 5: Rewire `app/actions/discover.ts`** to load the profile
  (`loadCriteria` → a loader that also returns the profile) and pass the signal
  into both builders.

- [ ] **Step 6: Update `components/Discover.tsx`** — window buttons render only
  when `hasRecency`; cards render `signal` then extras.

- [ ] **Step 7: Run and commit**

```bash
npm run build && npm test
git add lib/hiring-signal-prompt.ts lib/hiring-signal-prompt.test.ts \
        app/actions/discover.ts lib/types.ts lib/discovery-windows.ts \
        lib/discovery-windows.test.ts components/Discover.tsx
git commit -m "feat: Discover searches the profile's hiring signal, not funding rounds"
```

---

## Task 14: The product stops carrying the previous user's name

**Files:** `components/Nav.tsx`, `app/layout.tsx`, `app/signin/page.tsx`, `app/gate/page.tsx`

Four sites, verified by grep at `bac5fb1` (the spec says five; re-grep before
believing either number):

| Site | Now | Becomes |
|---|---|---|
| `components/Nav.tsx:27` | `Tom&apos;s GTM Job Search` | `Job Search` |
| `components/Nav.tsx:30` | `AI-powered GTM / RevOps job search — discover, research, track, analyze.` | `AI-powered job search — discover, research, track, analyze.` |
| `app/layout.tsx` `metadata` | `title: "GTM Job Search"`, `description: "AI-powered GTM / RevOps job search tool"` | field-neutral equivalents |
| `app/signin/page.tsx:26`, `app/gate/page.tsx:24` | `GTM Job Search` | the same neutral name |

- [ ] **Step 1: Re-grep and record the true count**

```bash
grep -rn "Tom\|GTM Job Search\|GTM / RevOps" app components | grep -v "\.test\." | grep -v tkeefe66
```

- [ ] **Step 2: Make the four (or however many) edits.**

- [ ] **Step 3: Extend `lib/career-neutrality.test.ts`** with a check that no
  file under `app/` or `components/` contains the previous owner's name — the
  cheapest possible guard against it coming back, and this repo has already
  inherited one owner's leftovers once.

- [ ] **Step 4: Run and commit**

```bash
npm run build && npm test
git add components/Nav.tsx app/layout.tsx app/signin/page.tsx app/gate/page.tsx lib/career-neutrality.test.ts
git commit -m "fix: the product no longer carries one user's name"
```

---

## Task 15: CLAUDE.md, and the one check that cannot be automated

**Files:** `CLAUDE.md`, the design doc

CLAUDE.md is loaded as standing instructions into every future session, so a
false sentence there misleads indefinitely. Four passages become wrong:

1. **The opening.** *"Single-user, AI-powered GTM/RevOps job search tool tuned
   to Tom Keefe's profile"* — it is now multi-tenant and career-agnostic.
2. **The search-criteria paragraph**, which says `scoringInputsFrom` "currently
   fills them with today's shipped GTM text … rather than a per-user value —
   that per-user sourcing is the later phase this work sets up". That phase is
   this one. Rewrite it to say where the profile lives and how it is resolved.
3. **The prompt-generalisation paragraph**, which lists what is "still
   hardcoded to venture-backed-tech vocabulary". After Task 13, `discover.ts` is
   no longer in that list; `FINANCIAL_SIGNALS` and `roleExtractionSchema`'s
   `seniority` enum still are — verify each by grep before writing the new list.
4. **The `app/actions/discover.ts` paragraph**, whose whole point is that the
   funding-analyst prompt is unguarded and out of scope. It is now in scope and
   done.

Add one new paragraph: the profile key, `resolveProfile`'s repair contract, the
gate's two mechanisms, and — the sentence a future session most needs — **the
guard**: `lib/career-neutrality.test.ts` fails if any production module holds a
career-specific string, and any field added to `Profile` belongs in it.

- [ ] **Step 1: Verify every claim you are about to write with a grep.** Phase
  1 produced twelve defects and all twelve were prose asserting something about
  code, written without opening the file.

- [ ] **Step 2: Edit CLAUDE.md.**

- [ ] **Step 3: THE MANUAL CHECK.** After the existing user completes
  onboarding on production, render their live fit prompt and diff it against the
  pre-change output.

  Test 1 (the fixtures) pins the BUILDER against fixed inputs. It cannot tell
  whether the values the user actually pasted at Step 4 match what they
  replaced. A dropped bullet or a trailing newline is exactly the silent
  divergence this codebase is built to catch, and the check is a one-off:

  ```bash
  # Before onboarding, from the current build:
  npx tsx -e 'import {buildFitPrompt} from "./lib/fit-prompt";
    import {loadScoringInputs} from "./lib/search-criteria";
    import {FIXTURE_ROLE} from "./lib/__fixtures__/fit-prompt-inputs";
    loadScoringInputs().then(i => console.log(buildFitPrompt(FIXTURE_ROLE, i)))' > /tmp/fit-before.txt
  # After onboarding, same command:
  ... > /tmp/fit-after.txt
  diff /tmp/fit-before.txt /tmp/fit-after.txt
  ```

  Expected: no diff, or a diff you can account for line by line. The pasted
  values are `lib/search-criteria.ts`'s old `DEFAULT_FIT_BRAIN` and
  `lib/fit-prompt.ts`'s `DEFAULT_TITLE_SCOPE` / `DEFAULT_DOMAIN_BONUS` — hand
  them over as text from git history, never retyped:

  ```bash
  git show bac5fb1:lib/search-criteria.ts | sed -n '/^export const DEFAULT_FIT_BRAIN/,/^`.trim();/p'
  git show bac5fb1:lib/fit-prompt.ts | grep -n "DEFAULT_TITLE_SCOPE\|DEFAULT_DOMAIN_BONUS"
  ```

- [ ] **Step 4: Verify the deployed commit before believing any live check.**

```bash
railway deployment list --service web --limit 1 --json   # meta.commitHash
git rev-parse main && git rev-parse origin/main
```
All three must agree. A rotation was once reported as verified when the route it
guarded did not exist in the running build.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-08-17-career-agnostic-onboarding-design.md
git commit -m "docs: CLAUDE.md describes the per-tenant profile"
```

---

## What this plan does NOT do

Carried from the spec's "Out of scope", plus one addition:

- Editing the onboarding *answers* after the fact. `/settings` edits the
  outputs; re-running the flow regenerates them.
- Multiple profiles per user.
- `BOARD_VENDORS` coverage. Link repair resolves Greenhouse/Lever/Ashby/Breezy/
  Workable; manufacturing runs on Workday and iCIMS, and Workday is excluded for
  a documented reason (its per-tenant site name cannot be derived from a company
  name). "Check links" degrades to the 404 re-check — **say so in the UI** rather
  than letting it read as broken.
- Search quality for generic titles. "Mechanical Engineer" matches an ocean
  where "Head of GTM Systems" matches a handful, and with no pagination or
  cross-run dedupe the same arbitrary 25 return each time. That needs a
  retrieval design.
- **Re-capturing the fit golden set for a non-GTM profile.** The gate currently
  proves agreement for one career only. Worth doing once a second real profile
  exists to capture against — which is a thing this plan creates and the next
  one should use.
- The `FINANCIAL SIGNALS` block and `roleExtractionSchema`'s `seniority` enum
  stay venture-shaped. Both are guarded in the prompt itself ("only if the
  candidate cares", "ABSENCE OF THIS DATA IS NOT A DEDUCTION"), so they degrade
  quietly rather than actively breaking — the distinction phase 1 drew, and the
  reason `discover.ts` (which has no guards at all) is IN scope here and they
  are not.

## Execution order and what can run in parallel

Tasks 1 → 2 → 3 → 4 → 5 → 6 are a chain and must run in order: Task 5 is the
atomic switch and every task before it exists to make that switch safe.

Tasks 7–11 (onboarding) depend on 1, 2 and 6 but not on each other beyond
7 → 8 → 10.

Task 12 gates Task 13. Task 14 is independent of everything. Task 15 is last.

---

## Self-review notes

**Spec coverage.** Every section of revision 3 maps to a task: storage → 1, 2;
the no-op constraint → 3, 4, 5 (fixtures asserted in the global constraints);
the flow and Step 0/4 → 10; generation → 7, 8; the gate → 9; the API-key-first
ordering → 10 Step 0; the existing account going through the flow → 15 Step 3;
Discover → 12, 13; the missed GTM sites → 3, 5; the comp carve-out seam →
already shipped in phase 1 (`domainBonusBlock` gates on both, `lib/fit-prompt.ts:167`)
and re-verified by the empty-blocks fixture; states around the billed call →
8 (answers persist first) and 7 (`RESUME_MAX_CHARS`, `PROFILE_TEXT_MAX_CHARS`);
re-run routes through the effects → 8 (`cachesOnboardingClears`); privacy → 7,
8, 10; error handling → the global constraints; naming → 14; CLAUDE.md → 15.

**One spec item is already done and the plan says so rather than redoing it:**
the carve-out/empty-block work landed in phase 1. A plan that re-specified it
would produce a commit touching only fixtures, which the global constraints
call a red flag.

**Two spec facts were corrected against the code** — the seven field-subject
constants rather than one `fieldNoun`, and `DateRange` living in
`app/actions/discover.ts` rather than `lib/types.ts` — both stated up front
rather than silently worked around.
