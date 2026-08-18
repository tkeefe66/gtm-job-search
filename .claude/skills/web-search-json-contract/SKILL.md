---
name: web-search-json-contract
description: Use when calling `callWithWebSearch` / `callWithWebSearchDetailed`, or handing a model response to `parseJson`, in `app/actions/` or `lib/crawler.ts`. Also use when a crawl run is scored `"error"` with a JSON parse message, when a healthy company stops being tracked, when a search action returns `Unexpected token ... is not valid JSON` to the user, or when changing what counts as closure evidence, the `stop_reason` gate, or the salvage path.
---

# Web search JSON contract — code map

**This is a reference, not a lesson.** It exists because the machinery is spread
across seven files whose connections are invisible from any one of them —
notably that a parse failure reaches a dead-page timer, and that `"empty"` is a
trust level rather than a count. Agents reliably work this out from the code;
they spend 7–10 tool calls doing it. This is that map.

## The failure it documents

Every search here is a Claude call with the `web_search` server tool that asks
for JSON in prose and gets back a string. **The model sometimes answers in prose
instead — nondeterministically, on a prompt that worked the day before.** On
2026-08-18 the crawler asked adobe for roles and got `"I found a …"`; the same
prompt returned correct JSON 27 hours earlier.

**Not a fence or boundary problem.** `parseJson` (`lib/model-call.ts`) already
strips fences and slices from the first `[` or `{`. If it throws, the response
contained no bracket anywhere.

## Where everything lives

| Thing | File | Note |
|---|---|---|
| Parse + recover, all four surfaces | `lib/salvage-call.ts` | `parseOrSalvage`, `arrayUnder` |
| The `stop_reason` gate | `lib/prose-salvage.ts` | `salvageDecisionFor`, allowlist |
| Stop reason plumbing | `lib/providers/types.ts` → `anthropic.ts` → `model-call.ts` | `stopReason` is **required** on `Completion` |
| Closure evidence gate | `lib/crawler.ts` | `runProvidesClosureEvidence` + `LAST_TRUSTWORTHY_RUN_SQL` |
| Dead-page timer | `lib/dead-tracking.ts` | 7 days, min 2 failures |
| Provenance column | `db/migrations/011_crawl_runs_salvaged.sql` | `crawl_runs.salvaged` |

## The two couplings that aren't visible locally

**A parse failure reaches the dead-page timer.** `crawlCompany`'s catch scores
`"error"`; `failed` is `status === "error" || status === "needs_url"`; that
stamps `failing_since`; `lib/dead-tracking.ts` untracks the company. Nothing
between the `throw` and the untracking mentions the model.

**`"empty"` is a trust level, not a count.** `LAST_TRUSTWORTHY_RUN_SQL` selects
`status in ('ok','empty') and not salvaged`, and `closeStalePostings` closes any
role absent from such a run. So a run that reports zero roles is asserting *this
company lists nothing* — which is why an unparseable response must not become
`"empty"`, and why a salvaged run is excluded even when it found roles (a
transcription of what prose happened to mention is not a complete listing).

## The gate

Salvage only a **confirmed-complete** answer; re-reading an incomplete one
manufactures a confident empty result, and empty is trusted.

| `stopReason` | Decision |
|---|---|
| `end_turn`, `stop_sequence` | salvage |
| `max_tokens`, `pause_turn`, `refusal`, `tool_use` | fail |
| unrecognised, or `null` | fail |

`pause_turn` is the one to keep in mind: it is what a long `web_search` turn
returns when the model pauses mid-flight, which is exactly the kind of turn the
search tier makes. An earlier denylist gate (fail only on `max_tokens`) admitted
it as complete. `null` fails closed — a provider that cannot report a stop
reason needs its adapter to map its own vocabulary onto these values, not a
permissive default.

## Adding a fifth search surface

Call `callWithWebSearchDetailed`, then `parseOrSalvage` with your own `key`,
`itemNoun`, and `extract`. Do not hand-roll the gate — its wrong version closes
live jobs, which is why it exists once.

`arrayUnder` accepts both a bare array and a keyed object **by design**: the
search prompts ask for a bare array, while the salvage schema must nest it to
also carry `message`. Handling one shape returns zero items while reporting
success.

If your surface can close, hide, or delete records based on an empty result,
gate that on provenance the way `runProvidesClosureEvidence` does.

## Known gaps

- A salvaged run clears `failing_since` like any success, so a page that is
  genuinely broken *and* provokes prose is detected more slowly.
- Repeated salvages are logged but not counted. A prompt that has drifted to
  returning prose every time looks healthy in `crawl_runs`.
- The three action surfaces recover, but a failed salvage still returns the raw
  `JSON.parse` message to the UI.
