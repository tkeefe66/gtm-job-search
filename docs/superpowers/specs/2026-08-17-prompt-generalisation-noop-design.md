# Prompt generalisation as a provable no-op — design

**Status:** revision 1, 2026-08-17. Not yet implemented.

**Phase 1 of three.** The parent design
(`2026-08-17-career-agnostic-onboarding-design.md`) opens this app to any career.
Two independent reviews of its revision 3 recommended splitting it, and this is
the first cut: **make every career-specific prompt string configurable, and prove
nothing changed.** Phase 2 is onboarding and the profile that fills these seams;
phase 3 is the Discover redesign, which still contains an unresolved research
probe and gets its own document.

**Every `file:line` was derived against `284a052`.** They rot — re-derive before
implementing.

## Why this is its own project

It is the piece that survives if the rest is abandoned. It has four properties
the other two phases do not:

- **Behaviour-preserving by construction.** Every extracted string ships with
  today's text as its default, so the rendered prompts are byte-identical.
- **Provable on day one.** `lib/__fixtures__/fit-prompt.no-floor.txt` and
  `.with-floor.txt` already exist. If they need regenerating, the work is wrong.
- **Safe to deploy at every commit.** `web` deploys from `main` on push
  (`CLAUDE.md`), so "green tests" is not the bar — *production keeps working* is.
  A no-op clears that bar trivially.
- **Independently valuable.** Even with no onboarding, the GTM assumptions stop
  being welded into six files.

## The principle: seams now, values later

Phase 1 introduces the parameters and passes **constants** into them. Phase 2
changes where the values come from, not the shape of anything.

That is what lets this phase avoid the parent spec's hardest open question —
whether the generated fragments resolve through `Criteria`, `FitInputs`, or a
profile overlay. Reviewers found the parent said two incompatible things. Here it
does not arise: `FitInputs` gains the fields, `scoringInputsFrom` populates them
from constants, and phase 2 swaps the source.

## What changes

### 1. `lib/fit-prompt.ts` — five extracted fragments

`FitInputs` (`lib/fit-inputs.ts`) gains five fields alongside `fitBrain` and
`compFloor`:

```
titleScope     the TITLE SCOPE SIGNALS bullets      (lib/fit-prompt.ts:179-183)
domainBonus    the AI-GTM transformation rule       (:201-206)
weakFitTail    the tail of the "2 =" clause         (:167)
moderateTail   the tail of the "3 =" clause         (:168)
strongTail     the tail of the "4 =" clause         (:169)
```

**Three separate tail fields, not one.** The tails are spliced at three distinct
positions inside the 1–5 guide; a single string cannot reach all three, and
replacing the whole guide would destroy the byte-identity proof's usefulness.

`scoringInputsFrom` (`lib/search-criteria.ts:323`) populates all five from new
`DEFAULT_*` constants carrying today's text verbatim.

### 2. The `TITLE SCOPE SIGNALS` heading stays in the template

The parent spec contradicted itself here — one section said the heading is a
positional anchor that must stay, another said an empty `titleScope` omits the
block. Both cannot hold: heading-in-template plus empty bullets renders a bare
heading over a blank line, which is the same dangling-fragment defect the parent
caught for `domainBonus` and missed for its twin.

**Resolved:** the heading stays in the template and the **whole block** —
heading and bullets together — is conditional on a non-empty `titleScope`. The
two positional tests that anchor on the literal
(`lib/fit-prompt.test.ts:301`, `:323`, via
`between(prompt, "SCORING GUIDE:", "TITLE SCOPE SIGNALS")`) get a second anchor so
they do not depend on a string that can now be absent.

### 3. The comp carve-out seam

`lib/fit-prompt.ts:206` ends the AI-GTM rule with
`${aiGtmCompCarveOut(inputs.compFloor)}`, whose text says the compensation floor
"overrides **this one**". Today that is always true, because the rule is always
present. Once `domainBonus` can be empty it is not.

**The carve-out renders only when both a comp floor and a non-empty
`domainBonus` exist.** With a floor and no bonus it would otherwise emit a
dangling pronoun into the prompt that scores every role.

This is also where the parent spec's byte-identity proof is thinnest, so it gets
its own fixtures — see Testing.

### 4. `fieldNoun` — one string, four splice sites

```
DEFAULT_FIELD_NOUN = "go-to-market and revenue operations"
```

| Site | Today |
|---|---|
| `lib/search-criteria.ts:58` `ROLE_SEARCH_SYSTEM` | "specializing in go-to-market and revenue operations roles" |
| `lib/search-criteria.ts:93-94` `roleExtractionSchema` | `fit_signal` / `ic_flag` defined in GTM terms |
| `app/actions/roles.ts:108` | "Search for open go-to-market and revenue operations roles at …" |
| `app/actions/role-search.ts:39` | "go-to-market / revenue operations roles … not just the obvious RevOps titles" |
| `lib/crawler.ts:346` | the same sentence, search-tier crawl |

**`roleExtractionSchema` is the one that matters most and is the least visible.**
Its `fit_signal` becomes `fit_summary` (`lib/ingest-roles.ts:156`), which
`buildFitPrompt` hands the scorer as `Summary:` (`lib/fit-prompt.ts:163`). GTM
framing is therefore an **input to the score on every row**, from all three ingest
paths — not a cosmetic label.

**Give every new parameter a default.** `roleExtractionSchema()` is called with no
arguments at `lib/search-criteria.test.ts:346`; a defaulted parameter keeps that
test passing unedited. Minimising test churn is not cosmetic here — the fewer
green tests this phase edits, the more the suite is evidence rather than
paperwork.

### 5. `stackQueries` — the template, not just the terms

`lib/search-criteria.ts:139` is:

```ts
queries.push(`"${tool}" revenue operations hiring ${place}`);
```

So making the tool list per-tenant without this would produce
`"SolidWorks" revenue operations hiring Denver`. The phrase is hardcoded, not
just the terms.

**A caution for phase 2, recorded here because this is where the seam is
made:** this site is a *search query*, not prose. The other four want a phrase
("mechanical design and manufacturing engineering"); a query wants a short term
("mechanical engineering"). One `fieldNoun` may not serve both well. Phase 1 does
not have to solve it — the default is today's string and today's behaviour — but
phase 2 should not assume one value fits four grammatical positions.

## What this phase explicitly does NOT do

- No profile document, no onboarding, no `/welcome`, no gate.
- **No emptying of `DEFAULT_FIT_BRAIN` or any other default.** That is phase 2's
  single atomic switch commit, and it is the only commit in the whole programme
  that changes live behaviour.
- No Discover changes.
- No branding or copy changes.
- No `fit_signal` → `fit_summary` rename. A reviewer proposed it; it is not needed
  for generalisation, and entangling a rename with a prompt-text change makes both
  diffs unreadable.

## Testing

The gate is `npm run build && npm test`. `npm run lint` is non-functional here.

1. **The fit-prompt fixtures are byte-identical.** This is the whole proof. If
   `lib/__fixtures__/fit-prompt.no-floor.txt` or `.with-floor.txt` changes by one
   character, the refactor altered what the model receives and is wrong.
   Per CLAUDE.md, regenerating a fixture blesses whatever the code emits — so a
   commit that touches only fixtures is a red flag, not a refresh.
2. **New fixture: empty `domainBonus` with a comp floor set.** Renders no dangling
   carve-out and no doubled blank line. `lib/fit-prompt.test.ts:426-436` is the
   existing test of that failure class — "the visible symptom of a seam that
   assumed its fragment was always non-empty."
3. **New fixture: empty `titleScope`.** The whole block absent, no bare heading.
4. **The four `fieldNoun` splice sites render grammatically** with the default and
   with a non-GTM value. `roleExtractionSchema` and `stackQueries` are already
   covered in `lib/search-criteria.test.ts`; the three prompt sentences are
   string builders and cheap to pin.
5. `lib/__fixtures__/fit-prompt-inputs.ts` gains the five fields. **This is the one
   file where a careless edit blesses whatever the code emits** — read the
   rendered diff in the same commit.

**Known test edits, stated up front so an unexpected one is a signal:**

- `app/actions/roles.test.ts:76` mocks `ROLE_SEARCH_SYSTEM` as a *string*. Deriving
  it makes that mock wrong.
- `lib/fit-prompt.test.ts:301`, `:323` — the second anchor, per §2.

Anything else going red means this phase stopped being a no-op.

**What has no test, stated rather than hidden:** that the extracted defaults are
*identical* to what they replaced is proven by fixture 1 for the fit prompt, but
the four `fieldNoun` sites have no equivalent golden output today. Fixture 4
creates it. Until it exists, a transcription slip in one of those four sentences
would pass the suite.

## Consequences

- `FitInputs` grows from two fields to seven. It is threaded through every batch
  caller (`ingestRoles`, `runRescorePass`, the crawl run context), so the change
  is wide but mechanical, and `ScoringArgs` in `lib/rescore-scope.ts` derives from
  `Parameters<typeof scoreFit>[0]` — which is what makes the widening a compile
  error rather than a silent gap.
- The fit golden set (`lib/fit-agreement.ts`) is **not** re-run. Fixture 1 proves
  the prompt did not change, so there is nothing for it to re-measure. If fixture 1
  fails, that decision reopens and it is a larger conversation.
- CLAUDE.md's description of the fit prompt gains a sentence about the extracted
  fragments. Its "tuned to Tom Keefe's profile" opening stays accurate until
  phase 2.
