# Provider support — design, revision 2

Date: 2026-08-17
Status: approved for planning

Revision 1 was reviewed twice and did not survive. Its foundation claim was
false, its measurement graded the wrong stage of the funnel, and two thirds of
its scope served a user who does not exist. What follows is roughly a third of
the work and serves the entire stated audience.

## What revision 1 got wrong

**The foundation claim was false.** It said all eight AI calls go through two
provider-neutral functions. `scoreFit` (`app/actions/parse-role.ts`) calls
`clientFor().messages.create` directly — it is the app's highest-volume model
call, running per role inside `ingestRoles`' `Promise.all` — and `saveApiKey`
uses the raw SDK too. That claim was made from a file listing rather than the
call graph, and it is what made "step 1 is a no-op refactor" wrong.

**Three call sites had no billing scope at all.** `parseRecruiterText`,
`parseJobUrl` and `scoreFit` were never wrapped in `withBudget`, so they billed
the platform key uncapped and unrecorded. Fixed in `4cf66f0`, before this
rewrite, because it was broken regardless of what the spec says.

**The `no-key` tier as designed would have billed the platform.** If a keyless
tenant is "not metered", `runScope` falls through to
`apiKey: ownKey ?? process.env.ANTHROPIC_API_KEY` — an uncapped platform-spend
path where a wall was intended.

**The measurement graded the wrong thing.** Three problems, any one of which
sinks the conclusion:

- *The fixed arm was censored.* The Discover prompt says "Return up to 20
  results"; the fixed arm returned 16, 20, 20 — capped in two of three runs. A
  capped yield cannot be compared to an uncapped one.
- *An outlier was pooled in.* Pair 1 supplied 10 of 14 fresh rows, and the spec
  itself said that run did not repeat. Excluding it, the cost advantage falls
  from 3.7× to 1.5×.
- *The expensive stage was never priced.* A discovered company only has value
  once pursued through `findAndSaveRoles` — an uncapped search plus per-role
  scoring, ~35–50¢. The fixed arm's lower precision (25% vs 47%) drags roughly
  three duds per hit instead of one, so it spends ~80¢ downstream to save ~16¢
  upstream. **The conclusion inverts once the next stage is counted.**

What survives from that work: run-to-run variance is large enough that no
search-quality claim can rest on one run, and a planner given no date context
writes queries for the wrong year and returns stale rows that still look like
results.

## What this revision does NOT do

**No external search API.** No Brave/Serper/Exa, no plan→search→read, no local
models. Reasons, in order of weight:

- A hosted Railway container cannot reach a user's `localhost:11434`. Step 5 of
  revision 1 served only people exposing an inference server to the internet.
- `openai-compatible` requires a tenant-supplied base URL. The server would send
  that tenant's decrypted key to an arbitrary host from inside Railway's private
  network — reaching `postgres.railway.internal` and the metadata endpoint — and
  `secret-box.ts` binds only `tenantId` as AAD, so the routing columns would be
  unauthenticated and swappable independently of the ciphertext.
- The role paths cannot be served by SERP snippets anyway. `roleExtractionSchema`
  demands the employer's own board URL and the exact posted salary; `roles.ts`
  and `crawler.ts` both instruct the model to *visit* each posting. Anthropic's
  tool fetches pages; a search API returns links. Reintroducing snippet-ranked
  links is precisely the regression that produced "29 of 61 rows were
  ZipRecruiter/Built In/Lensa" (CLAUDE.md).
- `parseJobUrl` and `resolveCareersUrl` are URL fetches, not searches. A plan
  step there is two model calls to produce one query.

If a real person asks for local models, revisit. For a GTM job-search tool that
is unlikely.

**No BYO-key-only wall.** Revision 1 retired the free tier entirely. That deletes
a funnel already built: `cappedMessage` renders *"You've used the $X of Claude
usage included with a free account… Add your own API key to keep going."* The
metering, the atomic reservation and the daily/monthly windows all exist and are
tested. A **one-time lifetime allowance** granted at approval is not subsidising
anyone's ongoing usage — it is a prepaid, hard-capped acquisition cost on a
waitlist the owner personally approves, and it is a smaller change than deleting
the tier. Without it, a new user's entire experience of a product whose
differentiator is the fit rubric is an empty table behind a credit-card wall.

## The design

### One interface, with the capabilities metering actually needs

```ts
interface Provider {
  id: "anthropic" | "openai" | "google";
  defaultModel: string;

  complete(opts: { system; prompt; maxTokens; jsonSchema? }): Promise<Completion>;
  searchAndComplete(opts: { system; prompt; maxTokens; maxSearches }): Promise<Completion>;

  /** Whether max-searches can be enforced INSIDE the request. */
  searchCapEnforcement: "in-request" | "none";
  /** Cost, per provider and resolved model. Never a shared constant. */
  costCents(usage: Usage, model: string): number;
  validateKey(key: string): Promise<boolean>;
}

interface Usage {
  inputTokens: number;      // EXCLUDING cached, normalised across providers
  cachedInputTokens: number;
  outputTokens: number;
  searches: number;
}
```

Three fields exist because the review found each of them missing:

- **`searchCapEnforcement`.** `lib/budget.ts` names in-request `max_uses` as the
  only thing making a ceiling enforceable, because search billing is invisible to
  token usage. That field is Anthropic-specific. On a provider reporting `"none"`,
  a metered tier's search calls are **refused**, not silently uncapped — the
  admin daily cap is runaway protection and must not degrade to a pre-call check.
- **`costCents`.** Sonnet's $3/$15 is hardcoded in `lib/metered.ts` and again in
  `lib/cost-estimate.ts`, and the second is rendered to users on `/settings`. A
  GPT tenant would otherwise see Claude-priced fiction.
- **`Usage`, normalised.** Anthropic's `input_tokens` excludes cached tokens;
  OpenAI's `prompt_tokens` includes them. Renaming fields would over- or
  under-count by exactly the cached portion.

`jsonSchema` is on `complete` from the start because constrained decoding is what
actually makes weaker models return parseable JSON, and freezing the signature
without it means rewriting every adapter later.

### Search counting

`recordUsage` currently counts Anthropic `server_tool_use` blocks. OpenAI emits
`web_search_call` items; Gemini returns `groundingMetadata.webSearchQueries` and
bills per grounded *request*, not per query. **Each adapter returns its own
`searches` count in `Usage`**; the caller never inspects response shapes.

### Fit-score portability is a ship gate, not an open question

Measured today: the same model, same inputs, three rounds over ten roles produced
**identical scores every time** — zero variance. So there is no noise for a
cross-model difference to hide in. If GPT scores a role 3 where Claude scores 4,
the user sees their table re-sort, permanently, with nothing explaining it.

`buildFitPrompt` is ~1,000 words of deliberately layered, conflicting rules with
explicit precedence — an AI-GTM rule that floors at 4, overridden by a comp
carve-out that caps at 3. Multi-hop precedence under contradiction is the first
capability to degrade below the frontier, and the failure is not a softer
distribution: it is the documented defect of "a role the table hides while its
fit score still reads 4."

**Before any second provider ships:**

- a checked-in golden set of ~30 real roles with their Claude scores;
- a per-provider agreement test reporting exact-match rate and mean absolute
  deviation, with targeted assertions on the two adversarial cases — a band whose
  top only *reaches* the floor must cap at 3 even under the AI-GTM rule, and
  unknown ARR/backer must not deduct;
- `jobs.fit_scored_model`, and a provider change treated as a scoring-input
  change in `lib/settings-effects.ts`, reusing `runRescorePass`.

The existing fixtures pin the prompt TEXT, not behaviour. They will be
byte-identical across providers while the scores diverge, which is worse than no
test because it reads as coverage.

### What a tenant configures

Provider, key, optional model. No base URL, no search key.

`tenant_api_keys` gains `provider` and `model` — and both must be bound into the
AAD alongside `tenant_id`, or the routing config can be swapped independently of
the ciphertext it routes.

## Sequencing

```
1. Registry + Anthropic adapter. Absorbs scoreFit and saveApiKey onto the
   interface; adds provider/model to BillingScope and the schema; replaces the
   MODEL constant (three importers) with per-tenant resolution.
   NOT a no-op — it changes the app's highest-volume model call.

2. Golden set + agreement harness + fit_scored_model. The gate, before a
   second provider can ship.

3. OpenAI adapter, native search. Serves the stated audience.

4. Lifetime allowance replaces the free tier's recurring windows.

5. Google adapter — when someone asks.
```

Step 4 comes after 3 deliberately: retiring the free tier before an OpenAI
adapter exists walls off exactly the users this work is for.

## Open questions

- **Does OpenAI's search cap uses per request?** If not, `searchCapEnforcement`
  is `"none"` and metered tiers cannot use search there. Verify before writing
  the adapter, not after.
- **Do reasoning models blow the tuned `maxTokens`?** The 8000 at `roles.ts` was
  set because search narration counted against output. Reasoning tokens also
  count, and an exhausted budget returns empty text, which `parseJson` throws on.
- **Rate limits.** `ingestRoles` fires up to 25 `scoreFit` calls in a
  `Promise.all`. The Anthropic SDK retries; a hand-rolled adapter does not, and
  low-tier OpenAI RPM limits will trip on that burst.

## Testing

| Test | Pins |
|---|---|
| Provider resolved from the tenant's stored config | The routing decision |
| A `"none"` cap provider refuses search for a metered tier | The ceiling does not silently degrade |
| `costCents` uses the adapter's price table, not a constant | The Claude-priced-fiction bug |
| `Usage` normalisation on cached tokens | The over/under-count |
| Golden-set agreement, with the two adversarial rows | The score the whole table sorts on |
| Every action runs inside a billing scope | The leak fixed in `4cf66f0` |
