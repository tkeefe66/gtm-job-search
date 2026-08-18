---
name: web-search-json-contract
description: Use when calling `callWithWebSearch` / `callWithWebSearchDetailed`, or handing a model response to `parseJson`, in `app/actions/` or `lib/crawler.ts`. Also use when a crawl run is scored `"error"` with a JSON parse message, when a healthy company stops being tracked, when a search action returns `Unexpected token ... is not valid JSON` to the user, or when deciding what a web-search call should do with a response it could not parse.
---

# Web search JSON contract

## Overview

Every "search" in this repo is a Claude call with the `web_search` server tool, and every
one of them asks for JSON in prose and gets back a string. **The model sometimes answers in
prose instead — nondeterministically, on a prompt that worked the day before.**

On 2026-08-18 the crawler's search tier asked adobe for roles and got `"I found a …"`. The
same company, same prompt, same tier had returned correct JSON 27 hours earlier.

**This is not a fence or boundary problem.** `parseJson` (`lib/model-call.ts:166-196`)
already strips ```` ``` ```` fences and slices from the first `[` or `{`. If it throws, the
response contained **no bracket anywhere** — the model emitted no JSON at all.

## The two rules

**Rule 1 — prose is a formatting slip, not an infrastructure failure.**

In the crawler, letting the throw reach `crawlCompany`'s catch scores the run `"error"`.
`failed` (`lib/crawler.ts:800`) is `status === "error" || status === "needs_url"`, which
stamps `failing_since`. After `DEAD_PAGE_GRACE_DAYS` (7) with `DEAD_PAGE_MIN_FAILURES` (2)
— `lib/dead-tracking.ts` — the row is set `tracking_enabled = false`. A careers page that
was working stops being crawled because the model phrased an answer badly.

**Rule 2 — do NOT map prose to `"empty"`. This is the intuitive fix and it is wrong.**

`"empty"` is not "no failure". It is **trusted evidence that the company currently lists
nothing**:

- `status = roles.length > 0 ? "ok" : "empty"` — `lib/crawler.ts:747`
- `LAST_TRUSTWORTHY_RUN_SQL` selects `status in ('ok', 'empty')` — `lib/crawler.ts:454`
- `closeStalePostings` closes any role absent from an `'empty'` run (ruling 2026-08-12)

So mapping an unparseable response to `"empty"` lets a formatting glitch **close live
jobs**, silently. That is strictly worse than the bug it fixes. This fix was proposed and
approved in conversation before anyone read the closure path; read it before proposing it
again.

## What to do instead

Re-read the model's own words under **constrained decoding** — a forced tool call, which is
structurally incapable of returning prose — and gate that on `stop_reason`.

| `stopReason` | Decision | Why |
|---|---|---|
| `"max_tokens"` | **Fail.** Rethrow, score the run `"error"`. | The text is incomplete narration. Re-reading it manufactures a confident `{"roles": []}` from a sentence that was still mid-thought — and that empty answer is trusted as closure evidence. A truncated run genuinely did fail; raise `maxTokens`. |
| anything else, including `null` | **Salvage.** | A completed prose answer is a formatting slip over real content. `null` salvages too: a provider that does not report a stop reason must not have every prose response scored as a dead page. |

The decision is `salvageDecisionFor` in `lib/prose-salvage.ts`; the wiring is
`extractViaSearch` → `salvageRolesFromProse` in `lib/crawler.ts:382-442`. `stopReason` is a
**required** field on `Completion` (`lib/providers/types.ts`) so a second adapter cannot
silently omit it — without it, truncation and non-compliance are indistinguishable.

Reach for `callWithWebSearchDetailed` (`lib/model-call.ts`) when you need the stop reason;
`callWithWebSearch` is a thin wrapper that drops it.

## Surfaces still carrying the raw pattern

Three call sites parse a web-search response with no salvage and no stop reason. **The
consequence there is different from the crawler's** — they are user-facing actions, so
nothing stamps `failing_since`; instead the search is already billed, the user gets zero
results, and `err.message` is returned straight to the UI as
`Unexpected token 'I', "I found a "... is not valid JSON`.

| Site | Note |
|---|---|
| `app/actions/roles.ts:124` | Already hit this once at `maxTokens: 2000` — see the comment at `:118`. Now 8000. |
| `app/actions/role-search.ts:209` | Web search here can be uncapped; a failed parse discards everything it paid for. |
| `app/actions/discover.ts:247` | `maxTokens: 4000`, the lowest of the three. |

Fixing one of these means giving it the same `callWithWebSearchDetailed` + salvage
treatment, not a local `try`/`catch` that returns `[]` — an empty return from Discover or
role search is read downstream as "nothing found".

## Red flags

- Catching a `parseJson` failure and returning `[]` or `"empty"` "so it doesn't crash"
- Adding a `CrawlStatus` value to represent an unparseable run — check first whether the
  existing trust rules (`status in ('ok','empty')`, `failed`) already give you what you need
- Raising `maxTokens` as the whole fix — it addresses truncation only, and adobe's failure
  was at 8000
- Treating a `stopReason` you do not recognise as truncation
