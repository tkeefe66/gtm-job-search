# Prompt generalisation as a provable no-op — design

**Status:** revision 2, 2026-08-17. Not yet implemented.

**Phase 1 of three.** The parent design
(`2026-08-17-career-agnostic-onboarding-design.md`) opens this app to any career.
This phase makes every career-specific prompt string configurable and **proves
nothing changed**. Phase 2 is onboarding and the profile that fills these seams;
phase 3 is the Discover redesign.

**Revision 1's central claim was false.** It proposed one `fieldNoun` spliced into
four sites. Review found that five of nine splice points cannot take a shared
value — the sites use four *different* grammatical forms — so the no-op would have
broken at three of them, two with no test that would notice. Revision 1 also
claimed a compile-error safety mechanism that does not exist, and named 2 test
edits where there are ~13. See "Revision corrections" at the end.

**The method error that caused it:** revision 1's table *paraphrased* the current
text instead of quoting it. Every string below is now quoted verbatim, because
that is what makes a mismatch visible on the page.

**Every `file:line` was derived against `feeb761`.** Re-derive before implementing.

## Why this is its own project

It is the piece that survives if the rest is abandoned:

- **Behaviour-preserving by construction** — every extracted string ships with
  today's text as its default.
- **Provable** — `lib/__fixtures__/fit-prompt.no-floor.txt` and `.with-floor.txt`
  already exist. If they need regenerating, the work is wrong.
- **Safe to deploy at every commit.** `web` deploys from `main` on push
  (`CLAUDE.md`), so the bar is not green tests but *production still working*.
- **Independently valuable** — the GTM assumptions stop being welded into the
  prompt builders even if onboarding never ships.

## The principle: seams now, values later

Phase 1 adds parameters and passes **constants** into them. Phase 2 changes where
the values come from, not the shape of anything. That is what lets this phase
avoid the parent's hardest open question — whether generated fragments resolve
through `Criteria`, `FitInputs`, or a profile overlay.

## Part A — the fit prompt

### A1. Five extracted fragments

`FitInputs` (`lib/fit-inputs.ts`) gains five fields beside `fitBrain` and
`compFloor`:

```
titleScope     the TITLE SCOPE SIGNALS bullets   lib/fit-prompt.ts:179-183
domainBonus    the AI-GTM transformation rule    :201-206, MINUS the trailing splice
weakFitTail    tail of the "2 =" clause          :167
moderateTail   tail of the "3 =" clause          :168
strongTail     tail of the "4 =" clause          :169
```

**Three separate tail fields, not one** — they splice at three distinct positions
inside one template literal.

`:206` ends with `${aiGtmCompCarveOut(inputs.compFloor)}`, so `DEFAULT_DOMAIN_BONUS`
is lines 201-206 **up to but excluding that interpolation**. A literal copy would
carry the interpolation as characters.

**The tails are contractually non-empty.** An empty `weakFitTail` renders
`2 = Weak fit — ` with a trailing space — the same dangling-fragment class as the
others, and invisible to the doubled-blank-line guard at
`lib/fit-prompt.test.ts:426` because it is a trailing space, not a blank line.
`resolveProfile` in phase 2 must therefore treat an empty tail as a repair case,
not a valid value. Recorded here because this is where the seam is cut.

### A2. The `TITLE SCOPE SIGNALS` heading moves out of the template literal

Revision 1 said "the heading stays in the template and the whole block is
conditional." Those cannot both be true — a heading inside the literal renders
unconditionally.

**Resolved:** the heading moves into a `titleScopeBlock()` helper, exactly as
`compScoringClause` already does. It renders
`"\n\nTITLE SCOPE SIGNALS (use these to adjust score):\n" + bullets` when
`titleScope` is non-empty and `""` when it is not. The bullets themselves carry
no leading or trailing newline — both blank lines belong to the wrapper. The
heading stays *in code*; it just stops being in the literal.

Same wrapper shape for `domainBonus`, which owns `\n\n` on the leading side only.

### A3. The comp carve-out

`aiGtmCompCarveOut` (`lib/fit-prompt.ts:134-137`) exists solely to beat the AI-GTM
rule's unconditional floor of 4. With no rule there is no floor to beat, and its
text ("the compensation floor overrides **this one**") has no referent.

**It renders only when both a comp floor and a non-empty `domainBonus` exist.**
Behaviour is unchanged for the current always-non-empty case, so
`ADVERSARIAL_CASES[0]` ("Bandtop AI", `lib/fit-agreement.ts:60-63`) is unaffected.

*Phase 2 caveat, recorded at the seam:* non-empty is necessary but not sufficient.
The carve-out presumes the bonus ends in an unconditional score floor. A generated
bonus without one still gets "The compensation floor overrides this one." appended.

## Part B — career phrasing, per site

**There is no shared `fieldNoun`.** The sites use four different grammatical
forms, and a shared value breaks the no-op at three of them. Each gets its own
constant carrying its exact current text:

| Constant | Verbatim text today | Sites |
|---|---|---|
| `SEARCH_SUBJECT` | `go-to-market and revenue operations` | `lib/search-criteria.ts:59-60` (`ROLE_SEARCH_SYSTEM`, **split across a concatenation** — see below), `app/actions/roles.ts:108`, `lib/crawler.ts:346` |
| `SEARCH_SUBJECT_SLASHED` | `go-to-market / revenue operations` | `app/actions/role-search.ts:39` — a slash, not "and" |
| `CANDIDATE_PERSONA` | `GTM Systems / RevOps / Marketing Ops leader and AI practitioner-builder` | `lib/search-criteria.ts:93` (`fit_signal`) |
| `BUILDING_CONCEPT` | `building GTM systems and agentic AI workflows` (and `no systems/AI-building upside`) | `lib/search-criteria.ts:94` (`ic_flag`) |
| `QUERY_SUBJECT` | `revenue operations` | `lib/search-criteria.ts:139` (`stackQueries`) |

Five constants, not one. Phase 2 decides whether generation emits five values or
one plus derivations — that is a phase-2 question, and forcing it now is what
broke revision 1.

**`ROLE_SEARCH_SYSTEM` does not contain the phrase as a contiguous literal.** It is:

```js
"You are a recruiting researcher specializing in go-to-market and revenue " +
"operations roles. Return ONLY valid JSON, no markdown, no preamble.";
```

The concatenation splits it at `revenue ` / `operations`. The *rendered* string is
identical to the other two sites, so byte-identity still holds — but a
find-and-replace across the repo silently misses this one, and an implementer
working from a grep would conclude the site does not exist. The concatenation has
to be restructured, not substituted.

`QUERY_SUBJECT` is a **search query** term, not prose. `stackQueries` builds
`` `"${tool}" revenue operations hiring ${place}` ``; a five-word phrase there
yields `"Salesforce" go-to-market and revenue operations hiring Denver`.

`CANDIDATE_PERSONA` is the one that matters most and is least visible.
`fit_signal` becomes `fit_summary` (`lib/ingest-roles.ts:156`), which
`buildFitPrompt` hands the scorer as `Summary:` (`lib/fit-prompt.ts:163`) — so it
is an **input to the score on every row**, from all three ingest paths.

### B1. Required parameters, not defaulted ones

`roleExtractionSchema()` has **four** call sites — `app/actions/roles.ts:110`,
`app/actions/role-search.ts:60`, `lib/crawler.ts:82` (the HTML crawl tier, which
per CLAUDE.md is the primary crawl path), `lib/crawler.ts:348`.

Revision 1 argued for a defaulted parameter to keep one test unedited. That trades
one line of test churn for **four sites that silently emit GTM text in phase 2**
if any forgets to pass the tenant value. Take the compile errors — that is the
direction this codebase prefers, and `lib/rescore-scope.ts:186-191` is an essay on
exactly this trade.

Same for `ROLE_SEARCH_SYSTEM` → `roleSearchSystem(subject)`: **four** call sites,
not the one revision 1 implied — `roles.ts:115`, `role-search.ts:195`,
`crawler.ts:331`, `crawler.ts:345`.

## What this phase does NOT do

- No profile, onboarding, `/welcome`, or gate.
- **No emptying of any default.** That is phase 2's single atomic switch commit.
- No Discover changes, no branding, no `fit_signal` → `fit_summary` rename.
- **`FINANCIAL SIGNALS` (`lib/fit-prompt.ts:185-199`) stays hardcoded**, and so do
  the `ARR:` / `Backer:` / `Exit signal:` lines (`:159-161`) and
  `roleExtractionSchema`'s `seniority` enum (`lib/search-criteria.ts:90`). All name
  venture-backed-tech vocabulary — ARR thresholds, PE exits, IPO paths, "a16z,
  Sequoia, Benchmark". They are *guarded* ("only if the candidate cares",
  "absence is not a deduction") so they degrade quietly, which is why they are
  deferred rather than urgent. **Deferred, not done** — revision 1 implied the job
  was finished after five extractions and it is not.

## Testing

Gate is `npm run build && npm test`. `tsconfig.json` includes `**/*.ts` with
`strict`, so `next build` typechecks test files — type errors fail the gate.

### The fixture decision, which revision 1 left unstated

`lib/__fixtures__/fit-prompt-inputs.ts:8-10` says *"Every value is distinct and
non-empty on purpose"*, and `FIXTURE_BRAIN` is deliberately **not**
`DEFAULT_FIT_BRAIN`. So two goals conflict:

- Setting the five new fields to the `DEFAULT_*` constants keeps the two `.txt`
  files byte-identical and proves the transcription — but breaks the
  distinct-value invariant and stops anything pinning "renders what it is HANDED,
  never a module default" (`lib/fit-prompt.test.ts:246-254`) for these fields.
- Setting them to distinct synthetic values preserves the invariant but forces
  both `.txt` files to regenerate, which this spec's own rule forbids.

**Resolution: both, in different fixtures.** `FIXTURE_NO_FLOOR` and
`FIXTURE_WITH_FLOOR` take the `DEFAULT_*` values, so the two existing `.txt` files
stay byte-identical. A **third** fixture set with distinct synthetic values pins
the handed-value property. Neither goal is sacrificed and neither fixture lies.

### Tests

1. **The two existing fit-prompt fixtures are byte-identical.** The whole proof.
   Per CLAUDE.md, regenerating a fixture blesses whatever the code emits — a
   commit touching only fixtures is a red flag, not a refresh.
2. **New fixture: empty `domainBonus` with a comp floor set** — no dangling
   carve-out, no doubled blank line.
3. **New fixture: empty `titleScope`** — whole block absent, no bare heading.
4. **New fixture set: distinct synthetic values** for the five new fields, pinning
   the handed-value property.
5. **Golden text for all five Part B constants at all nine splice sites.** These
   have **no coverage today** — `lib/search-criteria.test.ts:348` asserts only that
   eight field *names* appear in the schema, and `:117-135` asserts only `"hiring"`
   plus a tool and a location for `stackQueries`. Revision 1 called these "already
   covered"; they are not, which is why two of its three broken splices would have
   shipped green. `app/actions/role-search.ts:39` has no test file at all.
6. Fixtures 2-4 join the doubled-blank-line loop at `lib/fit-prompt.test.ts:431`.

### The test-edit list — ~13 red, 3 silent

Revision 1 named 2 and said anything else going red was a signal. That inverted
the signal: an implementer would hit eleven unexpected reds and start editing
tests green. The real list:

**Compile errors from `FitInputs` gaining five fields:**

| Site | |
|---|---|
| `lib/search-criteria.ts:324` `scoringInputsFrom` | intended |
| `lib/__fixtures__/fit-prompt-inputs.ts:31` `FIXTURE_NO_FLOOR` | |
| `lib/__fixtures__/fit-prompt-inputs.ts:38` `FIXTURE_WITH_FLOOR` | |
| `lib/fit-prompt.test.ts:250` | inline literal |
| `lib/fit-prompt.test.ts:271` | `const inputs: FitInputs` |
| `app/actions/parse-role.test.ts:60` | untyped literal to `scoreFit` |

**Runtime failures in `lib/search-criteria.test.ts`:** `:394`, `:435-437`, `:456`,
`:473`, `:485`, `:490`, `:503` — seven assertions across six tests.

**`:433-437` needs a decision, not a green-ing.** It asserts `FitInputs` has
exactly two keys, with the comment *"FitInputs is deliberately narrow… The keys
are the contract."* This spec widens it to seven and therefore reverses a stated
design decision. The rebuttal is that the fields it adds are *scoring* inputs of
exactly the kind the interface exists to carry, and that the alternative — a
second parameter on `scoreFit` — is what `lib/fit-inputs.ts`'s own header rejects.
Update the count and keep the comment's intent; do not delete the test.

**From `roleSearchSystem` becoming a function:** `app/actions/roles.test.ts:77`
plus four production call sites.

**Silent — no error, no red:** `lib/ingest-roles.test.ts:49` (`{} as never`),
`app/actions/roles.test.ts:80` (`fitInputs: {}` in a mock factory). Both on ingest
paths. Test 5 is what covers the Part B sites that would otherwise be silent.

### What has no compile-time protection

Revision 1 claimed `ScoringArgs` in `lib/rescore-scope.ts` makes the `FitInputs`
widening a compile error. **It does the opposite:**

```ts
export type ScoringArgs = Omit<Parameters<typeof scoreFit>[0], "fitInputs">;
```

The `Omit` deletes `fitInputs`, so the widening produces zero errors there. The
real protection is the six construction sites above — and the two cast sites that
stay silent. There is no type-level guarantee; the list is the guarantee.

## Consequences

- `FitInputs` grows from two fields to seven, against a test that pins it at two
  for a stated reason. See above — this is a reversal made deliberately, with the
  rebuttal recorded.
- The fit golden set (`lib/fit-agreement.ts`) is **not** re-run: test 1 proves the
  prompt did not change, so there is nothing to re-measure. If test 1 fails, that
  decision reopens.
- CLAUDE.md gains a sentence about the extracted fragments. Its "tuned to Tom
  Keefe's profile" opening stays accurate until phase 2.

## Revision corrections (1 → 2)

1. **The no-op was false at three splice sites.** `role-search.ts:39` uses a slash;
   `fit_signal` is a persona; `ic_flag` is a third form; `stackQueries` is two
   words. One `fieldNoun` cannot serve them. Replaced with five per-site constants.
2. **`ScoringArgs` does not catch the widening** — it `Omit`s `fitInputs`. The
   claim was backwards, and it was the spec's only argument that the widening was
   not a silent gap.
3. **"Already covered" was false.** The cited tests assert field names and the word
   "hiring" — not the GTM wording being extracted. Revision 1 said this in one
   paragraph and admitted the opposite two paragraphs later.
4. **The test-edit list named 2 of ~13**, inverting its own signal.
5. **The heading could not both stay in the template and be conditional.** It moves
   into a helper.
6. **"A second anchor" is not something `between()` accepts** — it hard-fails on
   `indexOf === -1`. And the two named tests do not need editing in phase 1 at all,
   since `titleScope` is non-empty throughout. Removed.
7. **`search-criteria.test.ts:433-437` pins `FitInputs` at two keys** with a stated
   rationale revision 1 reversed without noticing.
8. **Two production sites were missing:** `lib/crawler.ts:82` (the HTML crawl tier)
   and `lib/crawler.ts:331`.
9. **The tails had no empty-case handling** while the other two fragments got
   careful reasoning. Now contractually non-empty.
10. **Defaulted parameters traded four silent phase-2 sites for one line of test
    churn.** Reversed.
11. **"GTM assumptions stop being welded into six files" was overclaimed** —
    `FINANCIAL SIGNALS` and the venture vocabulary survive untouched. Now stated as
    deferred.
12. **The fixture values were unstated** where the two obvious choices are mutually
    exclusive. Resolved with a third fixture set.
13. Line drift: `roles.test.ts:76`→`:77`, `search-criteria.test.ts:346`→`:348`.
