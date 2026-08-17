# Prompt Generalisation (No-Op) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every career-specific prompt string out of the code and into a parameter, shipping today's text as the default, so the rendered prompts are byte-identical.

**Architecture:** Two parts. Part A adds five fields to `FitInputs` and extracts the fit prompt's GTM-shaped fragments behind block helpers. Part B replaces career vocabulary at nine splice sites with five per-site constants — deliberately **not** one shared value, because the sites use four different grammatical forms.

**Tech Stack:** TypeScript, vitest (`environment: "node"`), Next.js 14.

**Spec:** `docs/superpowers/specs/2026-08-17-prompt-generalisation-noop-design.md` (revision 3)

## Global Constraints

- **Gate: `npm run build && npm test`.** `npm run lint` is non-functional in this repo — never add it. **Never run `npm run build` while `npm run dev` is running**; they share `.next` and the build clobbers the dev server.
- **`main` auto-deploys on push.** The bar is not "tests green" but "production still works" — which a no-op clears trivially, provided it really is one.
- **THE PROOF: `lib/__fixtures__/fit-prompt.no-floor.txt` and `.with-floor.txt` must not change by one character.** The test at `lib/fit-prompt.test.ts:388` compares line count and every line. If a fixture needs regenerating, the task is wrong — do not regenerate it. Per CLAUDE.md, regenerating blesses whatever the code emits.
- **Every extracted string is copied VERBATIM.** Retyping is how a no-op stops being one. Copy from the file, do not transcribe from this plan's prose.
- **No behaviour changes anywhere.** No emptying of defaults, no profile, no onboarding, no Discover, no branding. Those are phases 2 and 3.
- Error contract (`.claude/skills/swallowed-string-errors`): `{ error?: string }`, the string can be EMPTY, detect by presence (`!== undefined`) not truthiness. No new error paths in this plan, but do not break existing ones.

## Expected test churn

Stated up front so an *unexpected* red is a signal rather than noise. Anything failing that is not on this list means the phase stopped being a no-op — stop and report.

| File | Why |
|---|---|
| `lib/__fixtures__/fit-prompt-inputs.ts:31,38` | `FitInputs` literals gain five fields |
| `lib/fit-prompt.test.ts:250,271` | two more `FitInputs` literals |
| `app/actions/parse-role.test.ts:60` | untyped literal passed to `scoreFit` |
| `lib/search-criteria.ts:324` | `scoringInputsFrom` return — intended |
| `lib/search-criteria.test.ts` `:394,:435-437,:456,:473,:485,:490,:503` | seven assertions over `FitInputs` shape |
| `app/actions/roles.test.ts:77` | mocks `ROLE_SEARCH_SYSTEM` as a *string*. Fails at RUNTIME, not compile time — `vi.mock` is untyped in vitest 2.1.9 |
| `lib/search-criteria.test.ts:348` | calls `roleExtractionSchema()` with no args |
| `lib/crawler.ts:332`, `lib/crawler.test.ts:59,65,69,75,90` | `buildExtractionPrompt` gains two parameters (Task 4) |

**`lib/search-criteria.test.ts:433-437` is a decision, not a green-ing.** It asserts `FitInputs` has exactly two keys, commented *"The keys are the contract."* This plan widens it to seven. Update the count and keep the comment's intent — the added fields are scoring inputs of exactly the kind the interface exists to carry. **Do not delete the test.**

**Silent, no red (three):** `lib/ingest-roles.test.ts:49` (`{} as never`), `app/actions/roles.test.ts:80` (`fitInputs: {}`), and `app/actions/roles.test.ts:82` (`roleExtractionSchema: () => "schema"`). None will error. They are not evidence of anything.

---

### Task 1: The three scoring-guide tails

The smallest extraction, done first because it proves the whole pattern against the fixtures before anything larger is attempted.

**Files:**
- Modify: `lib/fit-inputs.ts`
- Modify: `lib/fit-prompt.ts`
- Modify: `lib/search-criteria.ts` (`scoringInputsFrom`)
- Modify: `lib/__fixtures__/fit-prompt-inputs.ts`
- Modify: `lib/fit-prompt.test.ts`, `lib/search-criteria.test.ts`, `app/actions/parse-role.test.ts`

**Interfaces:**
- Produces: `FitInputs.weakFitTail`, `.moderateTail`, `.strongTail`; `DEFAULT_WEAK_FIT_TAIL`, `DEFAULT_MODERATE_TAIL`, `DEFAULT_STRONG_TAIL` in `lib/fit-prompt.ts`.

- [ ] **Step 1: Read the current text and copy it exactly**

Run `sed -n '166,170p' lib/fit-prompt.ts`. The five guide lines are there. **The split point is immediately after `— ` on lines 167, 168 and 169.** Line 166 (`1 =`) and line 170 (`5 =`) are career-neutral and are NOT extracted; line 170 also carries `${compScoringClause(inputs.compFloor)}` at its end, which stays exactly where it is.

- [ ] **Step 2: Add the three fields to `FitInputs`**

In `lib/fit-inputs.ts`:

```ts
  /**
   * The tails of the 2/3/4 clauses in the fit prompt's scoring guide — what
   * "weak", "moderate" and "strong" actually mean for this career.
   *
   * Three fields rather than one because they splice at three distinct
   * positions inside one template literal; a single string cannot reach all
   * three. The 1 and 5 clauses are not here: they are career-neutral as
   * written ("wrong industry, no relevant overlap" / "almost tailor-made").
   *
   * CONTRACTUALLY NON-EMPTY. An empty tail renders `2 = Weak fit — ` with a
   * trailing space, which is the same dangling-fragment defect the block
   * helpers in lib/fit-prompt.ts exist to prevent — and it is invisible to the
   * doubled-blank-line guard, because a trailing space is not a blank line.
   */
  weakFitTail: string;
  moderateTail: string;
  strongTail: string;
```

- [ ] **Step 3: Add the defaults and interpolate them**

In `lib/fit-prompt.ts`, above `buildFitPrompt`, add the three constants carrying **the exact text after `— ` on each line**. Then change lines 167-169 to:

```
2 = Weak fit — ${inputs.weakFitTail}
3 = Moderate fit — ${inputs.moderateTail}
4 = Strong fit — ${inputs.strongTail}
```

- [ ] **Step 4: Populate them in `scoringInputsFrom`**

`lib/search-criteria.ts:323` currently returns `{ fitBrain, compFloor }`. Add the three, sourced from the new constants. Phase 2 changes the source; the shape is what matters now.

- [ ] **Step 5: Update the `FitInputs` literals**

`lib/__fixtures__/fit-prompt-inputs.ts:31,38` — set all three to the `DEFAULT_*` constants, so the two `.txt` fixtures stay byte-identical. Also `lib/fit-prompt.test.ts:250,271` and `app/actions/parse-role.test.ts:60`.

- [ ] **Step 6: Run the proof**

```bash
npx vitest run lib/fit-prompt.test.ts
```

Expected: PASS, and specifically the two fixture tests at `:388` and `:395`. **If either reports changed lines, stop.** The extraction moved a character; find it rather than regenerating.

- [ ] **Step 7: Fix the `FitInputs` shape assertions**

`lib/search-criteria.test.ts:433-437` asserts two keys. Update to five and extend the key list. Keep the comment; add one sentence saying the tails are scoring inputs of the kind the interface exists to carry.

- [ ] **Step 8: Full gate and commit**

```bash
npm run build && npm test
git add -A
git commit -m "refactor: the fit prompt's 2/3/4 clause tails come from FitInputs"
```

---

### Task 2: `titleScope` and `domainBonus`, behind block helpers

**Files:**
- Modify: `lib/fit-inputs.ts`, `lib/fit-prompt.ts`, `lib/search-criteria.ts`
- Modify: `lib/__fixtures__/fit-prompt-inputs.ts`
- Create: `lib/__fixtures__/fit-prompt.empty-blocks.txt`
- Modify: `lib/fit-prompt.test.ts`

**Interfaces:**
- Consumes: Task 1's `FitInputs` shape.
- Produces: `FitInputs.titleScope`, `.domainBonus`; `titleScopeBlock()`, `domainBonusBlock()`.

- [ ] **Step 1: Read the exact whitespace**

`sed -n '176,186p;199,208p' lib/fit-prompt.ts`. Confirm: line 177 blank, 178 heading, 179-183 bullets, 184 blank. And 200 blank, 201 heading, 206 ends with `${aiGtmCompCarveOut(inputs.compFloor)}`, 207 blank.

**`DEFAULT_DOMAIN_BONUS` is lines 201-206 up to but EXCLUDING that interpolation.** Copying it literally would carry `${aiGtmCompCarveOut(inputs.compFloor)}` into the string as characters.

- [ ] **Step 2: Write the two block helpers**

```ts
/**
 * The TITLE SCOPE SIGNALS block, heading included.
 *
 * The heading lives HERE and not in the template literal, because a heading in
 * the literal renders whether or not there are bullets under it — and an empty
 * `titleScope` would then produce a bare heading over a blank line. That is the
 * same seam defect aiGtmCompCarveOut had, and the same shape compScoringClause
 * already solves by owning its own leading newlines.
 *
 * The bullets carry no leading or trailing newline. This wrapper owns only the
 * blank line BEFORE the block; the blank line after it stays in the template
 * literal, so the empty case still separates the surrounding sections.
 */
export function titleScopeBlock(titleScope: string): string {
  if (!titleScope) return "";
  return `\n\nTITLE SCOPE SIGNALS (use these to adjust score):\n${titleScope}`;
}

/**
 * The domain-bonus block, with the compensation carve-out that belongs to it.
 *
 * The carve-out renders ONLY when there is a rule for it to override. Its text
 * says the floor "overrides this one" — with no rule, "this one" has no
 * referent, and every tenant with a comp floor and no domain bonus would get a
 * dangling pronoun in the prompt that scores their every role.
 *
 * Behaviour is unchanged today, when the bonus is always present.
 */
export function domainBonusBlock(domainBonus: string, compFloor: number | null): string {
  if (!domainBonus) return "";
  return `\n\n${domainBonus}${aiGtmCompCarveOut(compFloor)}`;
}
```

- [ ] **Step 3: Splice them into the template**

Replace the literal heading+bullets (177-183) with `${titleScopeBlock(inputs.titleScope)}` positioned so the wrapper's `\n\n` supplies the blank line that is there today. Same for 200-206 → `${domainBonusBlock(inputs.domainBonus, inputs.compFloor)}`.

- [ ] **Step 4: Run the proof before anything else**

```bash
npx vitest run lib/fit-prompt.test.ts -t "against its fixture"
```

Expected: PASS. This is the step most likely to be off by one newline; get it green before writing new fixtures.

- [ ] **Step 5: Add the empty-block fixture**

Add a `FIXTURE_EMPTY_BLOCKS` to `lib/__fixtures__/fit-prompt-inputs.ts` — the `WITH_FLOOR` values but `titleScope: ""` and `domainBonus: ""` — and render it to `lib/__fixtures__/fit-prompt.empty-blocks.txt` using the command documented at `lib/fit-prompt.test.ts:351-358`. Add a matching test beside the two existing fixture tests, and add the new file to the doubled-blank-line loop at `:431`.

**Read the rendered file before committing it.** It must contain no `TITLE SCOPE SIGNALS` heading, no carve-out sentence, and no doubled blank line. This is a new fixture, so nothing pins it but your reading.

- [ ] **Step 6: Add the handed-value fixture set**

`lib/__fixtures__/fit-prompt-inputs.ts:8-10` says *"Every value is distinct and non-empty on purpose."* Setting the new fields to the `DEFAULT_*` constants (Task 1 Step 5) breaks that for those fields, and nothing then pins the property at `lib/fit-prompt.test.ts:246-254` — that the builder renders **what it is handed, never a module default**.

So add a third set with distinct synthetic values (`titleScope: "- SYNTHETIC TITLE SCOPE"`, etc.) and a test asserting the rendered prompt contains them and does **not** contain the `DEFAULT_*` text. No `.txt` fixture for this one — an inline assertion is enough and it cannot drift.

- [ ] **Step 7: Update the regeneration command**

The docblock at `lib/fit-prompt.test.ts:351-358` documents how to regenerate the
fixtures and writes **exactly two files**. Add the new ones. Left alone, the next
regeneration refreshes two of five and leaves three stale — the same "blesses
whatever the code emits" hazard, one level up from the fixtures themselves.

- [ ] **Step 8: Full gate and commit**

```bash
npm run build && npm test
git add -A
git commit -m "refactor: title-scope and domain-bonus blocks come from FitInputs"
```

---

### Task 3: `SEARCH_SUBJECT` and `SEARCH_SUBJECT_SLASHED`

**Files:**
- Modify: `lib/search-criteria.ts`, `app/actions/roles.ts`, `app/actions/role-search.ts`, `lib/crawler.ts`
- Modify: `app/actions/roles.test.ts`
- Create: `lib/search-subject.test.ts`

- [ ] **Step 1: Read all four sites verbatim**

```bash
sed -n '58,60p' lib/search-criteria.ts
sed -n '108p' app/actions/roles.ts
sed -n '39p' app/actions/role-search.ts
sed -n '346p' lib/crawler.ts
```

**`ROLE_SEARCH_SYSTEM` splits the phrase across a concatenation** — `"…go-to-market and revenue " + "operations roles…"`. A find-and-replace misses it. The concatenation must be restructured, not substituted.

**`role-search.ts:38-39` needs its WHOLE string extracted, not four words.** The sentence continues past the subject:

> "…roles that mention these tools. Titles vary — include **Business Systems Manager, Growth Systems Lead, Revenue Systems**, and similar, not just the obvious **RevOps** titles. Use these searches"

Three named GTM job titles are as career-specific as the subject in front of them. Extract the entire `FAMILY_INTRO.stack` value as `STACK_FAMILY_INTRO`. `FAMILY_INTRO.title` (`:36-37`) is career-agnostic and is left alone.

- [ ] **Step 2: Add the constants and the function**

```ts
/** What the search prompts call the field. Verbatim today's text. */
export const SEARCH_SUBJECT = "go-to-market and revenue operations";

/**
 * The whole stack-family intro, not just its subject.
 *
 * The sentence names three GTM job titles after the subject — "Business Systems
 * Manager, Growth Systems Lead, Revenue Systems… not just the obvious RevOps
 * titles" — which are exactly as career-specific as the four words in front of
 * them. Extracting only the subject would keep phase 1 a no-op and then, in
 * phase 2, produce a prompt that reads coherently for half a sentence before
 * naming RevOps roles at a mechanical engineer.
 *
 * FAMILY_INTRO.title is career-agnostic as written and stays in place.
 */
export const STACK_FAMILY_INTRO = "…copy the entire current value verbatim…";

export function roleSearchSystem(subject: string): string {
  return `You are a recruiting researcher specializing in ${subject} roles. Return ONLY valid JSON, no markdown, no preamble.`;
}
```

**Required parameter, not defaulted.** A default means a phase-2 call site that forgets to pass the tenant's value silently emits GTM text. Four compile errors now beat four silent sites later.

- [ ] **Step 3: Update the four `ROLE_SEARCH_SYSTEM` call sites**

`app/actions/roles.ts:115`, `app/actions/role-search.ts:195`, `lib/crawler.ts:331`, `lib/crawler.ts:345` → `roleSearchSystem(SEARCH_SUBJECT)`.

- [ ] **Step 4: Update the inline prose sites**

`roles.ts:108` and `crawler.ts:346` interpolate `${SEARCH_SUBJECT}`. `role-search.ts:38-39` becomes `stack: STACK_FAMILY_INTRO`.

- [ ] **Step 5: Fix the mock**

`app/actions/roles.test.ts:77` mocks `ROLE_SEARCH_SYSTEM` as a string. It becomes `roleSearchSystem: () => "system"`.

- [ ] **Step 6: Write the golden test**

These four sites have **no coverage today** — that is why two of revision 1's three broken splices would have shipped green. Create `lib/search-subject.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { SEARCH_SUBJECT, roleSearchSystem } from "./search-criteria";
import { STACK_FAMILY_INTRO } from "@/app/actions/role-search";

describe("the search subject renders into its sites", () => {
  test("roleSearchSystem reproduces today's sentence exactly", () => {
    expect(roleSearchSystem(SEARCH_SUBJECT)).toBe(
      "You are a recruiting researcher specializing in go-to-market and revenue operations roles. Return ONLY valid JSON, no markdown, no preamble."
    );
  });

  test("a different subject reaches the sentence", () => {
    expect(roleSearchSystem("mechanical engineering")).toContain(
      "specializing in mechanical engineering roles"
    );
    expect(roleSearchSystem("mechanical engineering")).not.toContain("go-to-market");
  });

  test("the stack intro keeps the job titles it names", () => {
    // The subject is four words of a longer sentence. If a future change
    // extracts only the subject, these three titles are left behind pointing at
    // the wrong career.
    expect(STACK_FAMILY_INTRO).toContain("Business Systems Manager");
    expect(STACK_FAMILY_INTRO).toContain("not just the obvious RevOps titles");
  });
});
```

- [ ] **Step 7: Gate and commit**

```bash
npm run build && npm test
git add -A
git commit -m "refactor: the search subject is a constant, not four literals"
```

---

### Task 4: `CANDIDATE_PERSONA` and `BUILDING_CONCEPT`

The highest-stakes task: `fit_signal` becomes `fit_summary` (`lib/ingest-roles.ts:156`) and reaches the scorer as `Summary:` (`lib/fit-prompt.ts:163`), so this text is an **input to the score on every row** from all three ingest paths.

**Files:**
- Modify: `lib/search-criteria.ts`, `app/actions/roles.ts`, `app/actions/role-search.ts`, `lib/crawler.ts`
- Modify: `lib/search-criteria.test.ts`

- [ ] **Step 1: Read `roleExtractionSchema` verbatim**

`sed -n '76,101p' lib/search-criteria.ts`. Copy the `fit_signal` and `ic_flag` descriptions exactly.

- [ ] **Step 2: Add the constants and the required parameters**

```ts
/** How the extraction prompt describes the candidate. Verbatim today's text. */
export const CANDIDATE_PERSONA =
  "GTM Systems / RevOps / Marketing Ops leader and AI practitioner-builder";

/** What "the kind of work this person wants" means, for ic_flag's positive clause. */
export const BUILDING_CONCEPT = "building GTM systems and agentic AI workflows";

/**
 * The SAME idea in ic_flag's negative clause, which words it differently:
 * "…mature orgs with no systems/AI-building upside". A compound adjective, not
 * a gerund phrase, so one constant cannot serve both positions without
 * rewording the prompt — and rewording is the no-op broken.
 *
 * Two constants for one idea is the pattern this project already settled on
 * with SEARCH_SUBJECT / SEARCH_SUBJECT_SLASHED / QUERY_SUBJECT. Assuming one
 * value fits several grammatical slots is what broke revision 1 of the spec.
 */
export const BUILDING_UPSIDE = "systems/AI-building upside";

export function roleExtractionSchema(persona: string, buildingConcept: string): string {
```

Required parameters. There are **four** call sites and a default would let any of them silently emit GTM text in phase 2.

- [ ] **Step 3: Update the three straightforward call sites**

`app/actions/roles.ts:110`, `app/actions/role-search.ts:60`, `lib/crawler.ts:348` — all pass `(CANDIDATE_PERSONA, BUILDING_CONCEPT)`.

- [ ] **Step 4: Widen `buildExtractionPrompt` for the fourth**

The fourth call site (`lib/crawler.ts:82`) sits **inside** an exported function:

```ts
export function buildExtractionPrompt(
  company: string,
  page: ExtractedPage,
  criteria: Criteria
): string {
```

So the required parameter cannot stop at the call site. Widen it to
`(company, page, criteria, persona, buildingConcept)` and update its callers:
`lib/crawler.ts:332` in production, and `lib/crawler.test.ts:59`, `:65`, `:69`,
`:75`, `:90`.

**Do not take the shortcut of hardcoding the constants inside the function body.**
That compiles, needs no test edits, and quietly exempts what CLAUDE.md calls the
primary crawl path — the one that runs nightly with nobody watching — from the
exhaustiveness the required parameter exists to buy. It is exactly how phase 2
ends up shipping a mechanical engineer a RevOps extraction schema.

The test callers pass `DEFAULT_CRITERIA` today; they pass the two constants
alongside it.

- [ ] **Step 5: Fix the existing schema test**

`lib/search-criteria.test.ts:348` calls `roleExtractionSchema()` with no arguments. Pass the two constants.

- [ ] **Step 6: Add golden coverage for the wording**

The existing test asserts only that eight field *names* appear. Add:

```ts
test("the persona and building concept reach the schema verbatim", () => {
  const schema = roleExtractionSchema(CANDIDATE_PERSONA, BUILDING_CONCEPT);
  expect(schema).toContain(
    "GTM Systems / RevOps / Marketing Ops leader and AI practitioner-builder"
  );
  expect(schema).toContain("building GTM systems and agentic AI workflows");
});

test("a different persona replaces it everywhere", () => {
  // fit_signal becomes fit_summary and is handed to the scorer as `Summary:`
  // (lib/ingest-roles.ts:156 → lib/fit-prompt.ts:163), so a leftover GTM
  // persona here is an input to every fit score, not a cosmetic label.
  const schema = roleExtractionSchema("senior mechanical engineer", "designing mechanical systems");
  expect(schema).not.toContain("GTM");
  expect(schema).not.toContain("RevOps");
});
```

- [ ] **Step 7: Gate and commit**

```bash
npm run build && npm test
git add -A
git commit -m "refactor: the extraction schema's persona is a parameter"
```

---

### Task 5: `QUERY_SUBJECT` in `stackQueries`

**Files:**
- Modify: `lib/search-criteria.ts`
- Modify: `lib/search-criteria.test.ts`

- [ ] **Step 1: Read it**

`sed -n '135,143p' lib/search-criteria.ts`. The template is `` `"${tool}" revenue operations hiring ${place}` `` — **two words, not five.** This is a search *query*, not prose; a five-word phrase here yields `"Salesforce" go-to-market and revenue operations hiring Denver`.

- [ ] **Step 2: Extract**

```ts
/**
 * The field term used inside a SEARCH QUERY, which is why it is short.
 *
 * Two words where SEARCH_SUBJECT is five. A query is not a sentence: the longer
 * phrase makes the query worse, not more precise. Phase 2 should not assume one
 * generated value serves both this and the prose sites.
 */
export const QUERY_SUBJECT = "revenue operations";
```

and interpolate it into the template.

- [ ] **Step 3: Pin the query shape**

`lib/search-criteria.test.ts:117-135` asserts only `"hiring"`, a tool token and a location. Add:

```ts
test("a stack query reproduces today's shape exactly", () => {
  const q = stackQueries({ ...SMALL, stackTerms: ["Salesforce"], locations: ["Denver"] });
  expect(q).toEqual(['"Salesforce" revenue operations hiring Denver']);
});
```

- [ ] **Step 4: Gate and commit**

```bash
npm run build && npm test
git add -A
git commit -m "refactor: the stack query's field term is a constant"
```

---

### Task 6: Record it in CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add to the fit-prompt paragraph**

Add two sentences: that the fit prompt's career-specific fragments (the 2/3/4 clause tails, `titleScope`, `domainBonus`) now arrive through `FitInputs` and default to the shipped GTM text; and that the checked-in fixtures staying byte-identical is what proves an extraction did not change behaviour.

**Do not change** the "tuned to Tom Keefe's profile" opening — it stays accurate until phase 2 empties the defaults.

Also record what is NOT extracted, so a future session does not assume the job is done: `FINANCIAL SIGNALS` (`lib/fit-prompt.ts:185-199`), the `ARR:` / `Backer:` / `Exit signal:` lines (`:159-161`) and `roleExtractionSchema`'s `seniority` enum all still name venture-backed-tech vocabulary. They are guarded ("only if the candidate cares", "absence is not a deduction") so they degrade quietly, which is why they were deferred.

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: CLAUDE.md records the extracted prompt fragments"
```

---

## Verification

Full gate after every task: `npm run build && npm test`.

The single most important signal is the two existing fit-prompt fixtures. They must be byte-identical at every commit. If they ever differ, the extraction changed what the model receives — find the character, do not regenerate the file.

After Task 5, confirm the whole surface is covered:

```bash
grep -rn "go-to-market\|revenue operations\|RevOps\|GTM Systems" lib app --include=*.ts | grep -v test | grep -v "^lib/search-criteria.ts:5[89]\|^lib/search-criteria.ts:9[0-9]"
```

Every remaining hit should be either a comment, or one of the deliberately-deferred sites named in Task 6.
