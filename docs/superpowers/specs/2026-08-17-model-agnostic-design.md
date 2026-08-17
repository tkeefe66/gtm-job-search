# Model-agnostic providers, and bring-your-own-key only — design

Date: 2026-08-17
Status: approved for planning

## Why

Two decisions, taken together, and each makes the other necessary.

**No free tier.** Every tenant supplies their own model API key. The platform
stops paying for anyone else's usage. The waitlist stays — approval is now about
whose data lands in this database and whose support burden is taken on, not about
rationing credits.

**Which means provider support becomes the gate on who can use the app at all.**
Anthropic-only would require every user to hold an Anthropic API key. Most people
who would want this hold an OpenAI key. So "which providers can they bring"
stops being a nice-to-have and decides the size of the addressable audience.

## What is already true

The abstraction boundary exists. Every AI call in the app — all eight — already
goes through two functions:

```ts
callWithWebSearch({ system, prompt, maxTokens, maxSearches }) → string
callStructured({ system, prompt, maxTokens })                 → string
```

Strings in, string out. That signature is provider-neutral as written. The
Anthropic-specific surface is confined to `lib/anthropic.ts` (SDK, model id,
`web_search` tool block, usage extraction) and the `sk-ant-` check in
`app/actions/api-key.ts`.

So swapping the MODEL is tractable. The work is search.

## The measurement, and what it establishes

Discover is the one path whose prompt relies on the model choosing its own
queries ("do multiple searches to ensure completeness"). By Role already computes
`titleQueries × locations` in code and hands the list over, so it barely uses
adaptivity at all.

Three paired runs on 2026-08-17, holding the search index and model constant and
varying ONLY who picks the queries:

| pair | adaptive rows / fresh | cost | plan→search→read rows / fresh | cost |
|---|---|---|---|---|
| 1 | 12 / 4 | 100¢ | 16 / 10 | 28¢ |
| 2 | 10 / 5 | 127¢ | 20 / 2 | 27¢ |
| 3 | 10 / 6 | 101¢ | 20 / 2 | 28¢ |
| **total** | **32 / 15 (47% fresh)** | **328¢** | **56 / 14 (25% fresh)** | **83¢** |

**Cost per FRESH company found: ~22¢ adaptive, ~6¢ fixed.** Roughly equal useful
yield — 5.0 against 4.7 fresh companies per run — for about a quarter of the
cost.

Two things this establishes, and one it does not:

- **Fixed queries are economically better and qualitatively worse per row.** They
  return more results with lower precision, so the extraction step must FILTER
  ON RECENCY rather than trust what comes back. That is a build requirement, not
  a caveat.
- **Run-to-run variance is high.** Overlap between the two arms was 6 of 22
  companies in the first pair. The first run showed 63% freshness for fixed
  queries and it did not repeat; a single run would have produced a spec claiming
  fixed queries are strictly better. **Three runs is the minimum for any future
  claim about search quality here.**
- **It says nothing about external search index quality.** Both arms used
  Anthropic's index. Whether Brave/Serper/Exa return comparable results is
  untested and needs a key — see Open questions.

A third finding worth carrying: the first attempt gave the planner no date
context, so it wrote queries for 2025 and returned stale rounds that still looked
like results. **The plan step is where context must be injected deliberately**;
`dateContextLine()` exists for exactly this and the planner must receive it.

## Design

### The provider registry

`lib/anthropic.ts` becomes one implementation behind an interface:

```ts
interface Provider {
  id: "anthropic" | "openai" | "google" | "openai-compatible";
  defaultModel: string;
  complete(opts: { system; prompt; maxTokens }): Promise<{ text; usage }>;
  /** Present only when the provider runs search server-side. */
  searchAndComplete?(opts: { system; prompt; maxTokens; maxSearches })
    : Promise<{ text; usage; searches }>;
  validateKey(key: string): Promise<boolean>;
}
```

`openai-compatible` is one adapter covering Ollama, vLLM, Together, Groq and most
self-hosted runtimes, since they share the OpenAI API shape. It implements
`complete` only.

`callWithWebSearch` becomes: resolve the tenant's provider → use
`searchAndComplete` if it exists → otherwise run the plan→search→read path below.
The eight call sites do not change.

### Search: native by default, external where there is none

| provider | search | who pays |
|---|---|---|
| Anthropic, OpenAI, Google | native, server-side | the tenant's key |
| openai-compatible / local | external API (Brave, Serper, Exa) | the tenant's search key |

This is what keeps "the platform pays for nothing" true while still admitting
local models. The two-key requirement lands only on self-hosting users, who have
already chosen to run their own infrastructure.

### The plan → search → read path

Used when the provider has no native search:

1. **Plan** — a small completion returning a JSON array of queries. Receives the
   date context, and is capped in count (that cap is what `maxSearches` becomes
   for this path).
2. **Search** — the external API runs exactly those queries.
3. **Read** — results are trimmed to a token budget and handed to the model for
   extraction, **with an explicit recency filter**: the measurement showed 75% of
   returned rows were stale, and a prompt that does not reject them passes that
   straight to the user.

Trimming is a real lever, not an implementation detail: 86% of a Discover run's
cost was input tokens from search results. How much snippet text enters the
context is a dial this design has and today's does not.

### What a tenant configures

Provider, API key, optional model override, and a search API key only when the
provider has no native search. Stored in `tenant_api_keys`, which already carries
per-tenant AEAD-sealed secrets with a `key_id` for rotation — it gains
`provider`, `model`, and a second sealed secret for search.

### What changes in what exists

- **`resolveTier` becomes `admin | byo | no-key`.** The free tier is retired. A
  tenant without a key is not metered — they hit a wall reading "add a key in
  Settings". `defaultDailyBudgetCents` / `defaultMonthlyBudgetCents` and their
  platform rows come out.
- **Admin caps stay** exactly as built: a daily window for runaway protection, a
  monthly outer bound, and a self-service raise. That reasoning never depended on
  a free tier.
- **Usage recording stays for everyone.** A tenant paying their own way wants to
  see what they spend, and it is how the app's own cost is known.
- **The crawl quota stays**, and its justification is unchanged: the nightly
  batch is ~21 company-crawls a week for the whole platform, so a heavy tenant
  consumes shared CAPACITY regardless of who pays for tokens.
- **`app/actions/api-key.ts`** loses its `sk-ant-` assumption and validates
  against the selected provider.
- **UI copy** stops saying "Anthropic" where it means "your model provider".

## Open questions

- **Is an external search index good enough?** Untested. Needs a Brave or Serper
  key and the same three-pair protocol, comparing against today's Anthropic
  results. This gates the local-model path only — native providers are unaffected
  — so it does not block the rest of the work.
- **Do weaker models return usable JSON?** `parseJson` already strips fences and
  hunts for boundaries because Claude is unreliable at it; smaller models are
  worse. The likely answer is per-provider response handling plus one retry, but
  it should be measured on a real local model before being designed.
- **Does the fit rubric behave the same across models?** The prompt was tuned
  against Claude. A tenant on GPT may get a different distribution from identical
  inputs, which matters because the score drives the whole table. Worth running
  the near-neighbour probe on a second provider once one exists.

## Sequencing

```
1. Provider registry, Anthropic as the only implementation   — no behaviour change
2. Retire the free tier; tier becomes admin | byo | no-key   — small, unblocks signup
3. OpenAI + Google adapters, native search                   — covers most users
4. External search + plan→search→read                        — unlocks local models
5. openai-compatible adapter                                 — local and self-hosted
```

Step 1 is deliberately a no-op refactor: it makes the second provider a day's
work rather than a rewrite, and it can ship and be verified before any provider
is added. Steps 3 and 4 are independent — most users are served by 3 alone.

## Testing

The provider interface is mockable, so adapter selection, key validation and the
plan→search→read sequencing are all unit-testable without a network.

What is NOT unit-testable is whether a given provider returns usable results.
That needs the three-pair protocol above against real APIs, and the variance
measured here is the reason: **any claim about search quality made from a single
run is noise.**

| Test | Pins |
|---|---|
| Provider chosen from the tenant's stored config | The routing decision |
| A provider without `searchAndComplete` takes the plan path | The fallback exists |
| The planner receives date context | The stale-query failure, which looked like results |
| Extraction rejects rows outside the recency window | The 25%-precision finding |
| Search results are trimmed to a token budget | The 86%-of-cost lever |
| Key validation calls the selected provider, not Anthropic | The `sk-ant-` assumption |
