# Handoff: after the provider registry shipped

Written 2026-08-17, late, at the end of the session that built and deployed step
1. This supersedes `2026-08-17-provider-registry-handoff.md`, which described the
world *before* step 1 and whose "The task" section is now done. Everything in
that file's **Traps**, **Settled** and **Errors made** sections is still true and
still worth reading; this file does not repeat it.

## Read first, in this order

1. `CLAUDE.md` — architecture. Its model-call section was rewritten today and now
   describes the registry. The empty-`{ error?: string }` doctrine governs every
   action in the repo.
2. `docs/superpowers/specs/2026-08-17-model-agnostic-design.md` — revision 2, the
   binding authority. Its `Provider` interface was corrected today to match what
   actually shipped.
3. `.claude/skills/swallowed-string-errors` — the project skill. Two fresh agents
   reproduced that defect verbatim without it.
4. `docs/superpowers/2026-08-17-provider-registry-live-checks.md` — what was
   verified against production and what was NOT.

## Where things stand

**Step 1 is shipped.** `main` = `origin/main` = deployed. Migration `007` applied
to production before the push, in that order, because the code selects columns
that did not previously exist. 820 tests / 55 files. `npm run build && npm test`
is the gate; `npm run lint` is non-functional here and must never be added.

Every model call resolves provider, key and model per tenant through
`lib/model-call.ts` → `lib/providers/`. `lib/anthropic.ts`, `clientFor()` and the
module-level `MODEL` constant are gone. `scoreFit` and `saveApiKey` — the two
places that held a raw SDK client — are on the interface. Anthropic is the only
adapter; `providerFor("openai")` throws and a test pins it.

**What is proven in production, and what is not.** This distinction is the point
of this section — do not upgrade the second list to the first without running it.

Proven: the migration applied and the columns and CHECK constraint exist; the
deployed commit matches `main` and `origin/main`; `GET /api/cron/crawl?dry=1`
returns 200, which exercises `loadTenantKey`'s new SELECT because `withBudget` is
entered per tenant *before* `getDueCompanies`; and a real Watchlist crawl ran a
Claude call through the facade on the fetch tier (`callStructured` → `complete` →
registry → adapter) and returned parseable output.

NOT proven: **`scoreFit` has never executed in production through the registry.**
The Watchlist "Check now" run that was used to test it crawled Nebius and found
zero roles (`ingestRoles(Nebius): 0 found`), and fit scoring only runs on roles
that were found. This is the app's highest-volume model call and the whole reason
step 1 was not a no-op refactor. **Close this first.** The cheapest way is a
"Check now" on a watchlist company that actually has open GTM roles; failing
that, one recruiter-message paste, which is a single `scoreFit` call at roughly
two cents.

Also not run: the `/settings` panel checks (model field renders, cost estimate
unchanged), a rejected key showing the closed-set sentence, and an unpriced model
being refused. All four are itemised in the live-checks doc.

## What comes next

**Step 2's remainder.** The golden set and agreement harness already landed in
`f7aadbb` — earlier than the plan's sequencing implies. What is still missing is
`jobs.fit_scored_model` and treating a provider change as a scoring-input change
in `lib/settings-effects.ts`, reusing `runRescorePass`. Small, and dead weight
until a second provider exists.

**Step 3 is BLOCKED on a question, deliberately.** Does OpenAI let you cap search
uses per request? The spec says verify this *before* writing the adapter, not
after. If it cannot, `searchCapEnforcement` is `"none"`, and a metered tier's
search calls are refused rather than silently uncapped — which changes what the
adapter is even for. `mustRefuseSearch` and its refusal path are already built
and tested against that answer; nobody has looked it up.

Two more open questions from the spec, both unanswered: whether reasoning models
blow the tuned `maxTokens` (8000 in `roles.ts`, set because search narration
counts against output — reasoning tokens do too, and an exhausted budget returns
empty text that `parseJson` throws on), and rate limits, since `ingestRoles` fires
up to 25 `scoreFit` calls in one `Promise.all` and the Anthropic SDK retries where
a hand-rolled adapter will not.

## Known gaps, carried deliberately

- **`ANTHROPIC_PRICES` has exactly one entry.** So the free-text model field on
  `/settings` accepts precisely one value while its copy reads "Optional." An
  unpriced model is refused at save time — that gate exists because
  `anthropicPrice()` falls back to Sonnet's rate, and without it an admin on Opus
  is metered at about a fifth of real spend and the daily runaway cap passes ~5×
  the intended dollars. **Populating the table is the real fix** and belongs with
  the OpenAI adapter.
- **The unpriced-model gate is save-time only.** Nothing sweeps at spend time.
  Unreachable today; it lands the moment the table grows or a row predates the
  gate.
- **`saveApiKey` is a key-validation oracle during a database outage.** The
  rate-limit gate reads a row; when the database is unreachable the gate opens and
  a live billable probe still fires before the insert fails. Pre-existing,
  unchanged by step 1, **needs its own ticket** — it was kept out of the refactor's
  fix wave on purpose so the fix and its reasoning are not buried in it.
- **`CLAUDE.md` line 9** still describes the app as a single-user shared-password
  gate, while Google sign-in, tenants, admin tiers, BYO keys and metering are all
  live. That drift predates this work and was not in scope tonight.
- Test-breadth minors, all recorded and none blocking: no assertion that
  `maxTokens: 500` still reaches `scoreFit`'s call (a silent regression to the
  facade's 4000 default would be invisible on the highest-volume call); no test
  for a response carrying `cache_creation_input_tokens` (unreachable — nothing in
  the repo sets `cache_control`); an unrestored `ANTHROPIC_API_KEY` in
  `lib/model-call.test.ts`.

## Things learned tonight that are not in the code

**A backup exists and restore has been proven.** Take one before any migration:
`railway run --service backup sh -c 'PGHOST=reseau.proxy.rlwy.net PGPORT=47766 node db/backup.mjs'`.
Tonight's is `gtm-job-search/2026-08-17.sql.gz`.

**Poll deploys on the deployment ID, not the status.** Record the current
deployment's id *before* pushing, then break only on a terminal state belonging to
a different id. Polling on status alone reads the previous deployment's `SUCCESS`
and reports a change as live before it has built.

**`tenant_api_keys` held zero rows when step 1 deployed.** The versioned AAD's
whole purpose — keeping pre-existing ciphertext openable — therefore had no blast
radius in production. It is still correct, still tested, and the next key saved is
`aad_version = 2`. Recorded because "we survived it" and "there was nothing to
survive" are different facts and only one of them is true.

**A green cron `?dry=1` with `crawled: 0` is still a real check** — `withBudget`
runs per tenant before `getDueCompanies`. Do not dismiss it, and do not oversell
it either: it proves the SELECT, not the scoring.

**Two documents nearly went missing tonight.** Revision 1 of the tenancy spec
existed only as a single commit on an unpushed local branch that revision 2 cites
by name. Before deleting any branch, check whether its unique commits hold
anything nothing else references — `git rev-list --count main..<branch>` answers
"is it merged", not "is it needed".

## Where the record lives

- Plan, with Task 8's live-check procedure and two corrections made after review:
  `docs/superpowers/plans/2026-08-17-provider-registry.md`
- Live checks, run and not-run: `docs/superpowers/2026-08-17-provider-registry-live-checks.md`
- Every ruling, deferred finding and review verdict from the build session:
  `.superpowers/sdd/2026-08-17-provider-registry/progress.md` (gitignored, local
  only — read it before assuming a decision was arbitrary)
