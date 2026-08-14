# Comp floor boundary: a band whose top only reaches the minimum is below it

**Status: complete.** Gate green. One commit on `worktree-floor`.

## The rule change

At a $200,000 floor, `$150,000 - $200,000` is now **below**; `$177,000 - $221,000`
**meets**. The reasoning the user gave: reaching the number would mean negotiating
to the absolute ceiling of the band, which is not meeting a minimum.

Landed in both places, worded so they agree:

1. **`lib/salary-filter.ts`** — `salaryBucketFor` now buckets on `base > floor`.
   The comment that documented `>=` as deliberate was replaced, not left in place;
   it now states the new rule with the user's two example bands.
2. **`lib/fit-prompt.ts` → `compScoringClause`** — a new bullet makes the
   band-top case explicit, and the old `at or above` bullet became
   `above the minimum, meaning the top of the range clears it outright`, so the
   two bullets no longer contradict each other. Structure and voice unchanged:
   still three-plus-one `- X = Y` bullets under the same heading.

Untouched, as required: `baseMaxFor`, `parseSalaryRange`, and the `ote` /
`no-range` / `unreadable` buckets. An OTE-only figure is still never compared
against a base floor.

## `aiGtmCompCarveOut` — same treatment, applied

**Decision: yes, spelled out in the carve-out too**, not left to the clause above.

The carve-out is read where it sits, inside the AI-GTM rule whose "floor score
of 4" it exists to beat. If "below the candidate's stated minimum" is read
narrowly there, a $150,000-$200,000 band at a $200,000 floor with an AI-GTM
mandate floors at 4 while the table buckets it "below" and the "Meets minimum"
toggle hides it — the exact table-versus-score divergence the compensation
clause closes, reopened by the one rule that outranks it. Referencing the clause
instead of restating it would leave the model to carry a definition across two
non-adjacent sections of the prompt.

New text: `→ If the posted base is below the candidate's stated minimum, or is a
range whose top only reaches it, cap at 3 regardless of this rule.`

## Fixture diff, read line by line

`lib/__fixtures__/fit-prompt.no-floor.txt` — **unchanged**, correct: both edited
functions return `""` when no floor is set, so no floor-free rendering may move.

`lib/__fixtures__/fit-prompt.with-floor.txt` — 3 insertions, 2 deletions:

```diff
@@ -26,7 +26,8 @@ SCORING GUIDE:
 COMPENSATION (the candidate stated a minimum base above — apply it):
 - Posted base clearly below that minimum = cap the score at 3 no matter how strong the rest of the fit is, and say so in the rationale. Do not drop it below what the rest of the fit earns; a below-floor role is a real role the candidate may still want to see.
-- Posted base at or above the minimum = no adjustment. Do not reward pay above the floor.
+- Posted base range whose TOP only reaches that minimum = treat it as below too, and cap at 3 the same way. Reaching the number would take negotiating to the absolute ceiling of the band, which is not meeting a minimum.
+- Posted base above the minimum, meaning the top of the range clears it outright = no adjustment. Do not reward pay above the floor.
 - No base published, or an OTE / on-target figure only = no adjustment either way. OTE bundles commission and is not a base figure — never treat it as one, and never guess a base from it.

@@ -49,7 +50,7 @@ AI-DRIVEN GTM TRANSFORMATION RULE (apply when all three are true):
-→ If the posted base is below the candidate's stated minimum, cap at 3 regardless of this rule. The compensation floor overrides this one.
+→ If the posted base is below the candidate's stated minimum, or is a range whose top only reaches it, cap at 3 regardless of this rule. The compensation floor overrides this one.
```

Three changed lines, all three intended: the new band-top bullet, the reworded
`at or above` bullet, the reworded carve-out. Nothing else moved — every scoring
tier, title-scope bullet and financial signal is byte-identical. Regenerated in
this same commit, after the guard failed and after reading this diff.

The `the two fixtures differ ONLY by the three compensation splices` test was
updated in step with it; its expected splice list is now six lines rather than
five, and it still asserts the no-floor rendering adds nothing of its own.

## Mutation results

| Mutation | Named test that failed | Reverted, passes |
| --- | --- | --- |
| `base > floor` → `base >= floor` | `salaryBucketFor > a band topping out exactly at the floor is below it` — `expected 'meets' to be 'below'` | yes, 24/24 |
| Delete the band-top bullet from `compScoringClause` | `compScoringClause > a band whose top only reaches the minimum is capped like a below-floor role` (plus the with-floor fixture test) | yes, 32/32 |
| Revert the carve-out to its old wording | `aiGtmCompCarveOut > carries the band-top rule itself, rather than leaving it to the clause above` (plus the with-floor fixture test) | yes, 32/32 |

**Compile-time rejections: none.** Every change is a comparison operator, prompt
string content, or a comment; nothing altered a signature, so no mutation in this
set was caught by `tsc` rather than by a test. `npm run build` (which typechecks)
compiled successfully throughout.

Note on the guard working as designed: before the fixtures were regenerated, the
prompt edit failed exactly two tests — `with a floor set, matches
fit-prompt.with-floor.txt exactly` and the two-fixtures-differ test — and the
no-floor fixture test stayed green. That is the intended failure shape.

## Boundary coverage in the tests

`lib/salary-filter.test.ts` pins both sides, so the suite cannot be satisfied by
an implementation that returns `"below"` for everything:

- `$150,000 - $200,000` at 200000 → `"below"` (flipped from `"meets"`)
- `$150,000 - $199,999` at 200000 → `"below"` (unchanged)
- `$150,000 - $200,001` at 200000 → `"meets"` (new)

No `.every(...)` was added. The existing ones in both suites already carry their
non-empty length assertions, and those were not touched.

## Gate

`npm run build && npm test` — build compiled successfully, **533 tests / 26 files
passed**. Baseline was 531/26; the two added tests are the band-top prompt bullet
and the carve-out band-top rule. `npm run lint` was not run (non-functional in
this repo by design).

## Not done — no credentials

**SKIPPED:** no database, no Anthropic key, no browser, no deploy. The prompt
change was never sent to a live model, and the filter change was never exercised
against real rows in `/roles`. Both are verified by unit tests and the fixture
only.

## Still open

- `docs/superpowers/plans/2026-08-13-compensation-floor.md:426` still quotes the
  old `return base >= floor ? "meets" : "below";` line. It is a historical plan
  record of work already shipped, not live guidance, so it was left alone as
  out of scope — flagging it in case you would rather it carry a correction note.
- **Nothing offers a rescore for this change, and existing scores are now the
  stale side of it.** A role whose band tops out exactly at the floor may have
  been scored 4-5 under the old prompt; the table will now file it "below" and
  hide it under "Meets minimum" while its score still says 4. The comp rescore
  offer (`compRescoreOffer` in `lib/rescore-progress.ts`) fires on
  `floorEditedThisSession` or on `comp_scoring_rescored_at` being unstamped —
  neither of which a prompt-text edit touches, and the stamp is permanent once a
  pass drains. A user who already rescored will never be prompted. Options, none
  taken here because they exceed this scope: clear
  `comp_scoring_rescored_at` as a one-off so the offer returns, or just re-save
  the floor on `/settings` to set `floorEditedThisSession` and accept the offer.
  Worth deciding before this ships.
