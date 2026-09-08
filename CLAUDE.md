# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Multi-tenant, career-agnostic, AI-powered job search tool. Next.js 14 (App Router) + TypeScript + Tailwind + Postgres + Anthropic API. Most backend logic is React Server Actions in `app/actions/`; the one exception is the secret-guarded cron route below. Every tenant's career domain — target titles, fit rubric, hiring signal, search-query vocabulary — comes from a per-tenant profile generated at onboarding (`lib/profile.ts`), not from a hardcoded GTM/RevOps default; see the profile paragraph in Architecture below. GTM/RevOps is still what the shipped `DEFAULT_PROFILE` renders as, because it is Tom Keefe's own career and that is what the pre-onboarding app's rendered prompt TEXT is a no-op against — it is a default now, not a ceiling. The one field that default does NOT carry is `fitBrain`, which ships empty and makes the app refuse rather than render anyone's career; see the profile paragraph below.

**The shared-password gate is GONE, and there is no middleware.** `middleware.ts`, `app/gate/` and `app/api/gate/` were deleted on 2026-08-17, along with the `GATE_TOKEN` variable on `web`. That gate was always labelled throwaway (`docs/superpowers/specs/2026-08-16-multi-tenant-auth-design.md` — revision 2; the 08-15 file is the superseded revision 1, kept only as a record) and it was removed once Google sign-in plus the pending-approval waitlist covered everything it did, because past that point it was pure redundancy that forced a shared secret on every invitee.

**What replaced it is per-surface, not global, so the coverage argument has to be re-made whenever a surface is added.** Middleware was attractive precisely because it covered Server Actions for free — those are RPC endpoints addressed by an ID that ships in the client bundle, so gating pages does nothing for them. Nothing covers them for free any more. The three standing invariants are: every `page.tsx` calls `requireActorPage()` (or `requireAdminPage()` for `/admin`); every exported server action refuses a session-less call, which `app/actions/auth-required.test.ts` asserts by importing each file in `app/actions/` and calling every exported function; and the only deliberately public surfaces are `/signin`, `app/api/auth/[...nextauth]` (the OAuth handshake) and the three cron routes `app/api/cron/crawl-next`, `app/api/cron/crawl` and `app/api/cron/purge-resumes` (a shared `CRON_SECRET` bearer check in `lib/cron-auth.ts`, failing closed). `app/page.tsx` holds no data and only redirects to `/discover`. The two actions on that test's `CRON_CALLED` exemption list were probed directly at removal time and refuse a session-less call anyway — they reach `resolveTenantId()`, which falls through to `requireActor()` outside a platform context. Adding a page without `requireActorPage()` is now an unguarded surface with no framework backstop, and only review catches it. (The Edge-runtime constraint that made middleware unable to do real auth still stands: it cannot reach Postgres, and Node-runtime middleware does not exist until Next 15.2.)

**A fourth invariant, learned the hard way on 2026-08-18: the session read must never deny by account status.** `getSessionAndUser` (`auth.ts`) enforces only what invalidates the session itself — the idle and absolute caps. Refusing a `pending`/`suspended`/`denied` user there returns `null`, which makes `auth()` report *no session* rather than a refused one, and `/signin` — which doubles as the waitlist screen — then cannot tell a waitlisted user from a stranger. It shows them the Google button, the click mints another session, `/discover` bounces them back, forever; one account logged three sessions in three minutes before this was found. Status denial belongs at the surfaces that can state a reason: `readActor` (`lib/require-actor.ts`) for every page and action, `signInView` (`lib/auth-policy.ts`) for the sign-in page. Both call `accessFor`, so fail-closed is unchanged, and status still arrives from the user row joined on every session read — a suspension bites on the next request. A source guard in `lib/auth-policy.test.ts` fails the build if `auth.ts` calls `accessFor` again.

**A fifth invariant, same day, same loop through a different door: `/signin` decides what to render in `signInBody` (`lib/auth-policy.ts`), never in JSX, and it consults the SESSION BEFORE the `?error=` notice.** Both `pages.signIn` and `pages.error` are `/signin`, so every Auth.js refusal lands there carrying a code — including the two this app raises itself by returning false from the `signIn` callback (unverified Google address, `sub` collision, both `AccessDenied`). Reversing those two lines hands a waitlisted user who arrives with any `?error=` the Google button, and the fourth invariant's loop is back, reached through the query string instead of the session. Two supporting rules: an UNRECOGNISED code must return a notice rather than `null` (Auth.js's client-safe set grows between betas, and a code this build has never heard of is still a failed sign-in that owes the user a sentence), and the button is withheld only where retrying provably cannot help (`Configuration`, `OAuthAccountNotLinked`). The decision is a pure function for the same reason `signInView` is: a server component's JSX is reachable from no test in this repo, so as a ternary this branch was green under a suite that could not see it.

## Commands

```bash
npm run dev        # local dev server (needs DATABASE_URL + ANTHROPIC_API_KEY in .env.local)
npm run build      # includes typecheck — the verification gate for changes
npm test           # vitest — pure logic in the crawl path
DATABASE_URL=postgres://... node db/apply-schema.mjs   # apply schema (idempotent)
```

**`tsconfig.json` declares no `target`, so `npm run build` typechecks at ES5.** The runtime is Node 24 and vitest compiles everything happily, so a regex `/u` flag or a `\p{L}` unicode property escape passes the whole test suite and then fails the build with "This regular expression flag is only available when targeting 'es6' or later". `npx tsc --noEmit --target es2017` does NOT reproduce the gate and will tell you the file is fine. `lib/role-key.ts`'s `NAME_SEPARATORS` is the worked example: it names the separator characters explicitly rather than using `[^\p{L}\p{N}]`, because the ASCII fallback `[^a-z0-9]` silently truncates "Nestlé" to "nestl". Raw `npx tsc --noEmit` also reports pre-existing errors in test files that the real build does not — do not chase them.

`npm run build && npm test` is the pre-deploy check. Tests cover the pure logic
in the crawl path only (`lib/*.test.ts`) — Claude calls and live fetches are
verified through the Watchlist "Check now" button and the cron route's `?dry=1`
mode. (`npm run lint` is non-functional in this repo — do not add it to the
gate.)

## Deploy

Railway only: project `gtm-job-search`, service `web` (+ Postgres service). Deploy with:

```bash
railway up --service web --detach
```

**The `web` service deploys from GitHub — `tkeefe66/gtm-job-search`, branch `main`, automatically on push.** There is no "Awaiting approval" step; a push ships. `railway up` still works and uploads the working directory, but prefer pushing, because of the trap below.

**A Railway variable change rebuilds from the connected GitHub repo, discarding whatever `railway up` uploaded.** This silently held production 108 commits behind for days: the service was wired to `tkeefe66/chad-job-search` (the previous owner's repo, frozen at an Aug 11 commit), so every `railway up` was reverted by the next variable edit. The symptoms were a `/settings` page that did not exist in production and a cron route returning 404 to the crawler every night. Fixed by pointing the service at `gtm-job-search`, whose `main` is current — so the rebuild-on-variable-change now produces the right code. **Keep `origin/main` current, or that trap comes straight back.**

Env vars on the `web` service: `DATABASE_URL` (reference var `${{Postgres.DATABASE_URL}}`), `ANTHROPIC_API_KEY`, and `CRON_SECRET` (the bearer token both `app/api/cron/crawl-next` and the legacy `app/api/cron/crawl` require, via `lib/cron-auth.ts` — auth fails closed, so a deploy missing this value makes every cron run 401 silently, with no log line to point at why). The `crawler` cron service needs the same `CRON_SECRET` value plus `WEB_URL` (the `web` service's public domain).

**Verify against the deployed commit, not the local one.** `railway deployment list --service web --limit 1 --json` carries `meta.commitHash`; compare it to `git rev-parse main` AND `origin/main` before believing any check you run against the live site. A rotation of `CRON_SECRET` was once reported as verified when the route it guarded did not exist in the running build.

**The required post-onboarding fit-prompt diff was PERFORMED on 2026-08-18 and is closed.** It used to be an open obligation here, because the fixture tests (`lib/__fixtures__/fit-prompt.*.txt`) pin the prompt BUILDER against fixed synthetic inputs and cannot prove that what the real user ends up with at onboarding matches the hardcoded text it replaced. Onboarding ran against production at `2026-08-18T01:58:02Z` (`app_settings.onboarded_at`), which is what unblocked it.

**Result: every extracted field DIFFERS, and that is the accountable outcome, not a failure.** The instruction this file used to carry expected the user to paste the old hardcoded values back; he did not — he onboarded from a résumé, so `fitBrain`, the three scoring-guide tails, `titleScope` and `domainBonus` are all newly generated text. What was verified instead is that the MECHANISM is unchanged: header, the whole ROLE block, the 1 and 5 scoring clauses, the COMPENSATION block, FINANCIAL SIGNALS, the compensation carve-out line and the closing JSON instructions render byte-identically, `compFloor` renders the same `$250,000` line on both sides, and no block came out dangling, empty, or double-spaced. `DEFAULT_TITLE_SCOPE`, `DEFAULT_DOMAIN_BONUS` and the three tails are byte-identical between `bac5fb1` and HEAD, which is what makes the pre-onboarding side reconstructible at all.

**How to re-run it, since `npx tsx` is NOT installed here.** The one-liner this file used to give does not work, and neither does `loadScoringInputs()` from a script — it resolves a tenant through `requireActor()` and there is no session. Read the rows directly and use the PURE functions instead (`mergeSettings(DEFAULT_CRITERIA, rows)` then `scoringInputsFrom(criteria, rows)`, both of which take rows), from a throwaway `*.test.ts` run through vitest so the `@/` alias resolves:

```bash
railway run npx vitest run lib/__fit-diff.test.ts   # a temp test that writes both renders to disk
```

Lift the pre-extraction brain out of git rather than retyping it — that instruction still stands and is the whole reason the comparison means anything:

```bash
git show bac5fb1:lib/search-criteria.ts | sed -n '/^export const DEFAULT_FIT_BRAIN/,/^`.trim();/p'
```

**One real defect the diff surfaced, in the DATA rather than the code, RESOLVED 2026-09-07:** the stored profile contradicted itself on the compensation floor — `fitBrain` and `compFloor` said $250K while the generated `weakFitTail` said $275K, and both numbers reached the model in one prompt. The user settled it on `/settings`. Recorded because the shape recurs: a generated profile field and a `SETTING_KEYS` row can disagree, and nothing in the code compares them.

**Redirects built from `req.url` in a route handler point at `localhost:8080`.** Railway terminates TLS and forwards to the container on `PORT`, so a route handler's `req.url` is the bound address, not the public host. Use a relative `Location` rather than rebuilding an absolute URL from `x-forwarded-host`, which is client-controlled and would make the redirect target attacker-influenced. The worked example used to be `app/api/gate/route.ts`; that file is deleted, so the rule now has no demonstration in the tree and applies to the next route handler that redirects. The two cron routes are the only route handlers left besides Auth.js's own, and both return JSON rather than redirecting.

**`.railwayignore` is load-bearing.** `railway up` uploads the working DIRECTORY, not what git tracks, so without it the gitignored `.env.production` and any `.env.local` are shipped into build images.

## Architecture

**Every "search" feature is a Claude call with the `web_search` server tool** — there's no scraper. `lib/model-call.ts` is the provider-neutral entry point for EVERY model call: `callWithWebSearch()`, `callStructured()`, `complete()` and `parseJson()` (fence-stripping/boundary-finding, because responses aren't strict JSON mode). Do not construct an SDK client anywhere else — `lib/anthropic.ts`, `clientFor()` and the module-level `MODEL` constant are gone.

**Provider, key and model are resolved PER TENANT, not from a constant.** `lib/model-call.ts` reads them off the ambient `BillingScope` and dispatches to an adapter in `lib/providers/` (`registry.ts` → `anthropic.ts`); `lib/metered.ts` resolves them from the tenant's `tenant_api_keys` row and prices reconciliation through `provider.costCents`. The scope is ambient rather than a parameter because `scoreFit` is reached three levels down inside `ingestRoles`' `Promise.all`. `lib/providers/anthropic-pricing.ts` is the ONE Anthropic price table (`lib/cost-estimate.ts` reads it, so it must never import the SDK — it is reached from a client component). Anthropic is the only adapter; `providerFor("openai")` throws, and a test pins that. Design: `docs/superpowers/specs/2026-08-17-model-agnostic-design.md`.

**`provider` and `model` are bound into the stored key's AEAD additional data**, versioned per row (`aad_version`), so rows sealed before that binding still open — a failed open is indistinguishable from "no key stored" and would present as a friendly empty state. Consequence: changing the model re-seals, and the plaintext is never read back, so the user must paste their key again.

When adding a web-search call, budget `maxTokens` generously: the model's search narration counts against it, and 2000 tokens has truncated responses before the JSON was emitted (see comment in `app/actions/roles.ts`).

**`lib/supabase.ts` is NOT Supabase** — it's a hand-rolled Supabase-shaped query builder over `pg`, kept so server actions read like Supabase calls. It connects via `DATABASE_URL`. Schema truth is `db/schema.sql` (eight tables: `jobs`, `watchlist`, `discovered_roles`, `discovered_startups`, `insights_cache`, `crawl_runs`, `role_searches`, `app_settings`); `supabase/migrations/` is legacy.

**Errors are `{ error?: string }` and the string can be EMPTY** — `if (res.error)` reads a
hard failure as a success. `pg` rejects with an `AggregateError` (message `""`) whenever
every address of a dual-stack host refuses, which is what an unset or unreachable
`DATABASE_URL` produces, so the failure mode is "the database is entirely unreachable" and
the symptom is a clean build with a silently wrong screen. Detection is PRESENCE
(`describeWriteFailure(error, "…")` from `lib/write-failure.ts`, then branch on
`!== undefined`); description substitutes only where text is shown. Transports
(`rawQuery`, `readAllSettingsResult`) keep the driver's message verbatim, empty included —
a transport that invents text makes the presence check untestable. An action whose failure
is NOT the database (Claude, parsing) substitutes its own fallback at the catch instead,
because `UNDESCRIBED_DB_ERROR` names the database and would be a false sentence there.
The project skill `.claude/skills/swallowed-string-errors` carries the full contract; two
fresh agents reproduced this defect verbatim without it. Eight instances were found in one
audit and a dedicated sweep still missed four.

**Search criteria are user-editable at `/settings`** — target titles, location terms, stack terms (labeled "Tools of the trade" on the page — the key stays `stackTerms`, only the label changed), the location rule, the fit brain, an optional search ceiling, and an optional minimum base compensation. They are stored one row per key in `app_settings` (key/value jsonb, so a new setting needs no migration) and resolved by `loadCriteria()` in `lib/search-criteria.ts`, which overlays saved rows on the shipped `DEFAULT_*` constants in that same file. Nothing is duplicated across prompts any more: every consumer takes the resolved `Criteria` as a parameter. The 1–5 rubric is `buildFitPrompt` in **`lib/fit-prompt.ts`**, not `parse-role.ts`: `"use server"` forbids non-async exports, so nothing in `parse-role.ts` can be exported pure or reached from a test. `scoreFit` itself stays in `app/actions/parse-role.ts` (model, system prompt, JSON parsing) and takes the brain plus the floor as an argument (`FitInputs`, from `loadScoringInputs()`). The fit prompt's other career-specific fragments — the 2/3/4 scoring-guide clause tails (`weakFitTail`/`moderateTail`/`strongTail`), `titleScope`, and `domainBonus` — now arrive through that same `FitInputs` rather than being read off a module constant, and `scoringInputsFrom` in `lib/search-criteria.ts` now fills them from the tenant's own profile — `profileFrom(rows)` in `lib/settings-store.ts` reads the `PROFILE_KEY` row and `resolveProfile()` repairs it, falling back field-by-field to the shipped GTM text (`DEFAULT_WEAK_FIT_TAIL`, `DEFAULT_TITLE_SCOPE`, `DEFAULT_DOMAIN_BONUS`, etc., all still in `lib/fit-prompt.ts` as `DEFAULT_PROFILE`'s values) only where a stored value is missing or the wrong shape. See the profile paragraph below for the full mechanism, including the one field — `fitBrain` — that does NOT fall back to anyone's career. Two checked-in fixtures in `lib/__fixtures__/` (`fit-prompt.no-floor.txt` and `.with-floor.txt`) staying byte-identical through that extraction is what proves it changed no behaviour: they pin the rendered prompt itself, not just the builder that produces it, so a change to what the model receives shows up as a diff even if every unit test around the builder still passes. The third fixture, `.empty-blocks.txt`, is NOT part of that proof and cannot be — it was created by the extraction commit itself, so it has no pre-extraction state to be identical to; it pins a configuration (both optional blocks empty) that had no rendering before. Its guard is the cross-fixture drift test instead. Changing what "a good fit" means = edit the fit brain on `/settings`, then accept the rescore offer. A save clears only the caches that change invalidates and, for crawler-relevant keys only, stamps `criteria_changed_at` — both decided in `lib/settings-effects.ts`. With `app_settings` empty every search runs on the same criteria it did before the settings page existed, with ONE deliberate exception: the By Role run is now uncapped by default rather than capped at 15 searches (~$1.13 against ~$0.55 — see `MAX_QUERY_MULTIPLIER` below).

**The fit prompt is pinned by checked-in fixtures** (`lib/__fixtures__/fit-prompt.no-floor.txt`, `.with-floor.txt` and `.empty-blocks.txt`, rendered from `fit-prompt-inputs.ts`), so any change to the prompt shows up as a diff in the rendered text rather than only in the builder. **Regenerating a fixture requires reading the diff in the same commit** — regeneration blesses whatever the code currently emits, so a commit that touches only fixtures is a red flag, not a routine refresh.

**The prompt-generalisation pass is not finished** — it deliberately stopped at the fit prompt and the search/extraction prompts. Still hardcoded to venture-backed-tech vocabulary rather than parameterized: the `FINANCIAL SIGNALS` block in `lib/fit-prompt.ts` (the ARR thresholds, PE-exit language, and "a16z, Sequoia, Benchmark" backer list) and the `ARR:` / `Backer / investor:` / `Exit signal:` lines it reads in the role block; and `roleExtractionSchema`'s `seniority` enum (`"VP/Head"`, `"Director"`, `"Senior Manager"`, `"Manager/IC"`) in `lib/search-criteria.ts`. Those three were left alone deliberately: each is guarded in the prompt itself ("only if the candidate cares", "ABSENCE OF THIS DATA IS NOT A DEDUCTION"), so for a non-GTM user they degrade quietly — the model is told to ignore what it can't find — rather than actively breaking.

**`app/actions/discover.ts` was the one surface that guarantee didn't cover, and it is now rebuilt rather than merely guarded.** Its old funding-analyst system prompt and per-window search prompt were the single largest block of unguarded venture vocabulary in the codebase — "You are a startup funding analyst… Focus exclusively on Series B and above", hard-searching TechCrunch/Crunchbase/Bloomberg for AI startup funding rounds, with nothing degrading quietly for a mechanical engineer or a nurse. Discover now searches the tenant's `HiringSignal` (`lib/profile.ts`) instead of funding rounds: `discoverStartupsInner` reads `profile.hiringSignal` off `loadCriteriaAndScoringInputs()` and renders it through `hiringSignalSystem()` / `buildHiringSignalPrompt()` in `lib/hiring-signal-prompt.ts`, which are pinned by their own fixture-style test the same way every other prompt builder in this directory is. For the shipped GTM profile the rendering is not byte-identical to the old hardcoded prompt — documented as a ruling at the top of that file — because reproducing the old prompt's parenthetical stage list and example queries verbatim in a template every profile now shares would put venture vocabulary straight back into a defence-contractor or hospital tenant's prompt, which is exactly what this task removes. The one piece of that ruling which WAS a real loss — the dropped exclusion clause — has since been restored as `HiringSignal.exclusions`; see the profile paragraph below. `getAllDiscoveredStartups` also changed independently of the signal work, in two steps. The first kept every distinct signal line per company (`signals: string[]`) instead of silently discarding repeats under one company spelling. The second (2026-08-18) replaced the KEY: it was `normalizeCompanyName`, which could not see that "RTX (Raytheon)" and "Raytheon (RTX)" name one employer, and is now `companyIdentityKey` (`lib/role-key.ts`), which compares the SET of meaningful words. `normalizeCompanyName` is deliberately untouched — it has a SQL twin (`NORMALIZED_COMPANY_SQL`) that the ingest dedupe compares against, and no Postgres expression can express token sorting, so widening it would drift the pair and refill `jobs` with duplicate "New" rows. The merge loop itself moved to `lib/discovered-merge.ts` so its keying/first-wins/append rules are reachable from a test, and because the merge is a GUESS, every spelling it absorbs is kept on the card as `alsoKnownAs` and rendered as an "also listed as …" line rather than disappearing. One residual single-user assumption survived the rebuild and was caught in review, not by the guard (it is a location, not a career phrase): `buildHiringSignalPrompt` hardcoded "prioritize companies that hire remotely or have a Denver/Colorado presence" ahead of the tenant's own `criteria.locationRule`, sending the previous user's city to every tenant's Discover prompt. Fixed — the hardcoded clause is gone and `criteria.locationRule` alone now carries that soft ranking preference, correctly for whatever location a given tenant's own rule names.

**The per-tenant career profile** replaces what used to be hardcoded GTM text everywhere the app previously assumed one career. `PROFILE_KEY` (`"profile"`) and `ONBOARDED_AT_KEY` (`"onboarded_at"`), both in `lib/settings-store.ts`, are standalone `app_settings` keys — deliberately NOT members of `SETTING_KEYS`, for the same reason `JOB_STATUSES_KEY` already wasn't: the profile's value is a whole object and the stamp is an app-written value nobody edits, and either would force a fourth shape group onto `mergeSettings`, which is shape-guarded for the list/text/number values that ARE `Criteria` fields. The profile is replaced WHOLE at onboarding or on a `/settings` save, never merged field-by-field. `resolveProfile()` in `lib/profile.ts` REPAIRS whatever is in the jsonb row rather than rejecting it — the same contract `resolveStatuses` established for job statuses — so a model that returns prose where a list was asked for produces the shipped default for that field, not a fit brain that reads "undefined"; every returned `Profile` is fresh, never a reference into `DEFAULT_PROFILE`, so a caller can't corrupt the module-level default for the life of the process.

**The fit brain has two sources, and the precedence is deliberate.** `scoringInputsFrom` resolves it as `criteria.fitBrain || profile.fitBrain` — the `fitBrain` row under `SETTING_KEYS` wins, and the profile's brain is only the fallback, because that row is what `/settings` displays and edits; if the profile won instead, a non-empty profile brain would permanently shadow every settings edit the user makes. `DEFAULT_FIT_BRAIN` (`lib/search-criteria.ts`) is now `""`, and `DEFAULT_PROFILE.fitBrain` (`lib/profile.ts`) is `""` too — with both empty the app REFUSES rather than falling back to anyone's career, but the two refusals are not equally load-bearing. `emptyBrainRefusal` inside `scoreFitInner` (`app/actions/parse-role.ts`) covers every path that scores, because ALL scoring — `findAndSaveRoles`, the crawler, role search, the rescore pass, onboarding's own preview — goes through the single `scoreFit` entry point. `emptySearchReason` is a PER-ACTION check with exactly one call site today (`app/actions/role-search.ts`); `findAndSaveRoles` and the crawler never call it. Consequence: with an empty profile, a search action that skips `emptySearchReason` still RUNS and still BILLS — it finds roles and only then fails to score them via `emptyBrainRefusal`. Money can be spent against an empty profile; wrong scores cannot be produced. A new billed search action must call `emptySearchReason` explicitly to avoid the first half of that. The PAGE-level gate is separate and redundant with both on purpose: `requireActorPage()` (`lib/require-actor.ts`) redirects an un-onboarded tenant to `/welcome` before a page even renders, reading the onboarding stamp through `readOnboardedAtFor(tenantId)`; `requireAdminPage()` — `/admin` only — opts out by passing `allowUnonboarded: true`, so a bug in onboarding can never lock out the one account able to approve pending users.

`readOnboardedAtFor(tenantId)` in `lib/settings-store.ts` takes its tenant EXPLICITLY and should keep doing so — but not to avoid recursion, which was a false claim this file carried until it was checked against the actual call chain and corrected. `readOnboardedAtFor`'s only caller is `requireActorPage()`, which gets its `Actor` from `readActor()`, never from `requireActor()`. Had `readOnboardedAtFor` resolved its own tenant via `resolveTenantId()` (`lib/tenant.ts`), that would call `requireActor()`, whose body is `readActor()` plus a null check — a call that terminates, with nothing looping back into `requireActorPage()` or `readOnboardedAtFor`. There is no cycle. The unbounded case this comment used to warn about belonged to a different, REJECTED design (Task 9 of this branch's plan): an earlier revision put the onboarding check *inside* `requireActor()` itself, so `requireActor()`'s own call to `readAllSettingsResult` — which calls `resolveTenantId()`, which calls `requireActor()` again — re-entered the very check that was running. That design was never shipped. The parameter stays for its real reasons: it is explicit about which tenant the read is for, and it avoids a second, redundant session read, since `requireActorPage()` already has `actor.tenantId` from its own `readActor()` call.

**The guard, and its limit.** `lib/career-neutrality.test.ts` has three checks. Two fail if any production module outside `lib/profile.ts` / `lib/fit-prompt.ts` holds one of the eleven career-specific phrases extracted into the profile (`searchSubject`, `querySubject`, `stackFamilyIntro`, `candidatePersona`, `buildingConcept`, `buildingUpside`, the three scoring-guide tails, and `titleScope` / `domainBonus` — the last two were missing from the check until the branch's final-fixes pass, caught because `Profile` has eleven career-text fields excluding `fitBrain` (its shipped default is `""`, nothing to scan for) and the guard scanned only nine), or imports one of six now-deleted GTM constant names (`SEARCH_SUBJECT`, `QUERY_SUBJECT`, etc.). The third is unrelated to the profile fields: it fails if any file under `app/` or `components/` names the previous owner (`\bTom\b`, case-insensitive) — the check most likely to trip on a future edit that pastes in example copy. Any field added to `Profile` belongs in the first two. **But the phrase checks catch only the strings that were extracted** — three career-specific, user-visible strings were found by hand instead, during this same work, and none of them were things the guard could see: a `"Denver/CO GTM / RevOps"` phrase in a Discover empty-state message, a `"GTM stack"` dropdown label in `RoleSearchPanel`, and a `"GTM stack terms"` tooltip in `RolesTable` — all three since fixed, none present in the current codebase. `DEFAULT_PROFILE.hiringSignal`'s shipped values are the same kind of gap and are still unfixed: `"funding rounds"`, the `"Series B and above"` qualifier, and the publication list (`"TechCrunch"`, `"Crunchbase"`, …) are career-specific text the guard never scans, because `hiringSignal` was never added to `PHRASES`. It proves the switch is complete for the strings this project identified; it does not prove the app never assumes a career.

**A role that reads weak is FILED, not kept.** `lib/fit-cutoff.ts`: a fit score below
`MIN_KEPT_FIT_SCORE` (3) moves the row to the tenant's first terminal, non-hidden status
instead of leaving it `New`. Measured, not assumed — across 194 scored roles every 1 and
every 2 the user had ever touched was marked Not Interested, ten for ten, none pursued.
Two guards make it fair and both are load-bearing: it never files a role whose posting was
NOT read (`posting.enrichedAt` missing — a score computed from the extraction's one-line
summary is not evidence the role is weak, and those stay in the enrich queue), and it never
touches a row whose status the user has already moved. `Posting Closed` is excluded as a
destination however the config is ordered: it is terminal, but it is a CLAIM that the
posting is gone, and the link checker would act on it. A config with no terminal status
files nothing rather than inventing a key. It applies at BOTH points where a score is
written — `ingestRoles` and `rescoreAll` — because the rescore is where a row scored blind
gets its fair hearing once a backfill has given it a posting. **A role the USER added is
exempt** (`IngestOptions.chosenByUser`): the cutoff exists to keep a SEARCH's output from
filling the table, and a URL somebody pasted is a decision the app must not silently
overturn — the first manual add scored 2, filed itself, and vanished from the open list.
Such a role is still scored, and the confirmation names the number. **The rubric itself is
untouched:** telling the model to answer only 3–5 was considered and rejected, since it
relabels weak roles rather than removing them and destroys the signal the cutoff needs.
The three rescore queries also skip terminal rows entirely (`notTerminalSql` in
`lib/rescore-scope.ts`, whose placeholder is an ARGUMENT because the three queries number
their parameters differently) — 57 of 161 scored rows were terminal, a third of every pass
bought for nothing.

**Compensation**: `salary_range` is stored verbatim as the posting wrote it and parsed at READ time by `parseSalaryRange` in `lib/salary.ts` — base preferred over OTE, so `$280K–$325K (base); $305K–$365K OTE` is a $280–325K role. The optional floor lives in `app_settings` under `compFloor`. It filters `/roles` on DISPLAY only (`lib/salary-filter.ts`: two independent toggles, both off by default; `ote` is its own bucket and is never hidden as "below") — no job is ever dropped or hidden at ingest because of pay. `scoreFit` receives both the posting's stated range and the floor. **The boundary is strict (`>`, not `>=`): a band whose top only REACHES the floor is below it** — `$150K–$200K` fails a $200K floor, `$177K–$221K` clears it. That rule lives in TWO places and they must not drift: `salaryBucketFor` (the display bucket) and `compScoringClause` + `aiGtmCompCarveOut` in `lib/fit-prompt.ts` (the scoring rule). Changing one alone produces a role the table hides while its fit score still reads 4 — and the carve-out needs it too, because it outranks the compensation clause. Because that changed `scoreFit`'s inputs on deploy rather than on an edit, `/settings` offers a one-time rescore gated on the `comp_scoring_rescored_at` stamp (`compRescoreOffer` in `lib/rescore-progress.ts`); the pass itself is `runRescorePass`, never a hand-rolled loop.

**Posting detail lives in a `posting jsonb` column, and the `enrichedAt` stamp inside it — NOT the column's presence — is what "already read" means.**
Ingest used to produce the posting's substance, hand it to `scoreFit`, and throw it away:
the row stored `""` where the model had seen real text, so every rescore
(`scoringArgsFor`, `lib/rescore-scope.ts`) was strictly impoverished — and the rescore's
score is the one that persists. `ingestRoles` now writes `key_skills`,
`company_description`, `department` and `posting` (requirements + nice-to-haves,
`lib/posting-detail.ts`, which REPAIRS whatever the model returned rather than rejecting
it — nothing normalizes a role array, every path casts `parsed as Role[]`). The column is nullable with no
default, so a row predating it is distinguishable from one nothing was found for. **The
backfill's "thin" predicate is `posting.enrichedAt` missing, not `posting is null`** —
that first version was a defect: ingest always writes `posting` (deliberately, so a row
the model had nothing for is not re-billed forever), which made every NEWLY INGESTED role
permanently ineligible for enrichment however thin its content, and the row looked
enriched while carrying a one-search-covers-ten-roles summary. Only the posting-reading
path writes `enrichedAt`, so it is the honest question, and an unparseable stamp counts as
unread. `db/migrations/017_posting_detail.sql`, applied to
production 2026-09-07. Read it as `job.posting ?? null` everywhere — `getJobs` and
`repairJobLinks` both `select *` into `Job`, and the ES5 build does not catch
`job.posting.requirements` against a null. The structural guard is
`INGEST_EXEMPT_COLUMNS`: a test captures `addJob`'s real argument and asserts every
`SCORING_INPUT_COLUMNS` entry outside that set is written, so a column a rescore reads and
ingest forgets is a failing test rather than a silent drift. Only `arr`, `exit_signal` and
`backer` are exempt — hand-entered from the discovered-startup context, with no producer
anywhere.

**Ingest reads the posting BEFORE it scores, and the backfill is for history and retries.**
`ingestRoles` calls `readPosting` (`lib/posting-read.ts`) for up to `MAX_INGEST_READS` (6)
of a run's new roles, skipping any that are already dead or link-less, and feeds what it
finds to `scoreFit` — because `fit_score` is computed at ingest, so reading afterwards
costs three operations (score, read, rescore) where one ordering gets it right once. The
bound is a bound on one REQUEST, not a ration on quality: the crawler gets one request per
company against Railway's 300s edge timeout, and a measured crawl already costs up to
91s. Roles past the bound are stored unread and stay in the backfill's queue. `readPosting`
is shared by both callers deliberately — two copies would drift on the parts that are
invisible when wrong: the robots gate, the page-then-board order, and the refusal to
escalate to search.

**The enrich backfill (`app/actions/enrich.ts`, the "Enrich roles" button on `/roles`)
reads ONE posting per row, and every bound on it is deliberate.** One plain HTTP fetch
plus one NON-SEARCH model call per row; it must NEVER escalate to the `web_search` tier,
which would turn a free-tier backfill into a billed search across the whole table — a JS
shell is skipped and reported instead. Bounded per BATCH, not per pass, because
`withBudget` reserves and checks the ceiling exactly ONCE per call: N calls inside one
scope pass a single check at row 0 and then bill regardless, and sixty rows of
(fetch + call) would not answer inside Railway's 300s no-data edge timeout anyway, losing
the report of what was spent. Paging is by CURSOR (`enrichBatch`), NOT the rescore's
`passStartedAt`: a row that was READ stops matching the thin predicate on its own but a
BLOCKED one never does, so re-reading the thin set would hand every later batch the same blocked
rows and never drain. The guardrail (`enrichGate`, `lib/enrich-scope.ts`) is POSITIVE
EVIDENCE OF WRONGNESS, and its aggregator branch comes FIRST and ignores the verification:
`verifyPostingLink` answers `notApplicable` for a reseller link as well as for a company
careers site, and a reseller answers 200 with plausible content long after the req closed,
so "proceed" would store fiction. A `relink` is WRITTEN before the corrected URL is read,
through `relinkPatch` (`lib/relink.ts`) — the one copy of the first-relink-only rule, now
shared with `repairJobLinks`' two call sites. The action carries its OWN
`readOnboardedAtFor` check: a page guard is not coverage for a Server Action.
`emptySearchReason` is deliberately not the gate — it refuses on an empty fit brain, which
enrichment does not read.

**`readPostingPage`, not `classifyFetchOutcome`, judges a single posting.** The crawler's
classifier delegates to `isJsShell`, whose second clause requires three job LINKS — the
right question for a careers LISTING and the wrong one for a posting, which links to one
job or none. Using it here classified every real posting as a shell and skipped the entire
table while reporting a clean pass. `readPostingPage` (`lib/page-extract.ts`) keeps only
the length test, which is the half that actually detects an unrendered SPA. **A client-rendered posting is read through the employer's board API instead**
(`fetchPostingBody`, `lib/resolve-job-link.ts`): Greenhouse and Workable through a
per-posting call, Ashby and Lever out of the board payload they already publish every
description in. Breezy is excluded — its board list carries no body and its per-posting
JSON only redirects — and every vendor here was control-tested the way `BOARD_VENDORS`
demands: a nonsense slug AND a nonsense posting id on a real board must both fail. This is
not the "no ATS vendor APIs" rule being bent; that rule is about how roles are DISCOVERED,
and this reads one already found. An unrecognised payload parses to null, never `""`,
because `""` would be stored as "this posting says nothing". Related:
`fetchPage` and `fetchAllowed` now live together in `lib/fetch-page.ts` and neither is
exported without the other, because two copies of the robots rule would be a policy
regression rather than a bug — silent, and visible only to the site being fetched. Gate
BEFORE the fetch, never after; a robots.txt that could not be READ is not permission.

**Enrichment offers a rescore, gated on server state at both ends.** A row that just
gained real `key_skills` and `company_description` carries a `fit_score` computed from
strictly less than a rescore would now use. `enrichRescoreOffer`
(`lib/rescore-progress.ts`) shows while any row's `posting.enrichedAt` is STRICTLY newer
than the `enrich_rescored_at` setting — `>=` would re-offer a rescore already paid for,
forever, which is the `compFloor` boundary hazard in the same shape and a test bites on
it. `ENRICH_RESCORED_AT_KEY` is standalone, NOT a member of `SETTING_KEYS`, for the same
reason the other three stamps are not. A drained pass stamps BOTH markers: one
`runRescorePass` re-scores every scored row through the same `scoreFit`, so stamping only
the trigger that raised the prompt would bill a second identical pass for nothing. Design
and the two places the spec was wrong: `docs/superpowers/specs/2026-09-07-posting-detail-design.md`.

**Manual intake: `addRoleFromUrl` (`app/actions/add-role.ts`, "Add by URL" on `/roles`),
URL first with paste as the FALLBACK.** The reason is identity, not convenience: pasted
text carries no employer, no canonical link and no posting id, so it cannot be deduped,
re-checked for liveness, or attributed without the user typing what the URL already knows.
A URL feeds `readPosting` and `jobPostingFrom` (the page's schema.org JobPosting), so one
paste yields the JD, the employer's own name and title, and — on an ATS deep link — a
posting id `verifyPostingLink` can re-check forever. The paste box appears ONLY when the
read failed, with the reason, and the row keeps the URL either way. This is the only
mechanism in the app that reaches hosts which block automated readers in principle
(Indeed, ZipRecruiter, LinkedIn, Workday tenants, openai.com), and measured 2026-09-07
those hosts were almost the entire unread backlog. A URL for a role already tracked
ATTACHES to that row — the posting, the corrected link (through `relinkPatch`, so nothing
is lost) and a fresh score — rather than refusing as a duplicate, because the duplicate was
never the point and the JD was.

**The BOARD tier (`extractViaBoard` in `lib/crawler.ts`, `lib/board-source.ts`) sources a
tracked company's roles from its own hiring board, and `boardTrust` is the whole safety
story.** A guessed slug elsewhere in this codebase produces a bad LINK on a row that
already exists; under enumeration it would CREATE rows — a stranger's postings under this
company's name, live so they pass the URL check, then scored, billed and eligible to be
auto-filed. So a slug READ out of an employer's own posting URL may source roles, and a
GUESSED one only when the board itself names the employer and that name agrees under
`companyIdentityKey`. Ask the BOARD for that name (`fetchBoardIdentity`), never a posting:
a company on a custom careers domain publishes posting URLs no slug parses back out of, so
the posting route failed for exactly the boards most needing it (measured: Databricks).
Vendors publishing no name cannot corroborate a guess and are refused. **Closure is handled
explicitly**: `seenTitles` feeds `titlesToClose`, so `runProvidesClosureEvidence` takes the
board's provenance and returns false for a guessed slug AND for an EMPTY board — a vendor
answering `{"jobs":[]}` is indistinguishable from a parser broken by a shape change, and
two nights of that would close every crawl-sourced role at a company. Title filtering
happens BEFORE ingest (`rolesFromBoard`) because `ingestRoles` fans out unbounded
`Promise.all`s, and it matches on WORD SETS with seniority words dropped: substring
matching a configured phrase ("Director of Revenue Operations") against a board's own
titles ("Marketing Platform Operations Manager") was measured against a real 89-posting
board and found NOTHING.

**A job board's SEARCH page is not a role, and a description is not an employer**
(`lib/not-a-posting.ts`). `indeed.com/q-…-jobs.html` names a query whose results change
daily; `Confidential (via CSG Talent)` is a recruiter's discretion. Fifteen such rows were
found stored and scored. Rejected at ingest before anything is spent, and closable by
`repairJobLinks` first and with no network call, since they are decidable from the row
alone. Both checks are narrow because a false positive closes a real role: matching is on
the URL SHAPE rather than the host (all three serve real postings too), and a placeholder
name must be the whole company or be followed by a qualifier — "Confidential Computing
Inc" is a real employer.

**`likely-closed` is the one `UnclearReason` built from TWO signals**: the employer's site
refused to be read at all AND the board found for that company does not list the title.
Either alone is worth nothing — a 403 is routine, a guessed board proves nothing — but
together they were right eleven times out of eleven on 2026-09-07. Reported and led in the
list, never auto-closed; the slug is still a guess. `removalMarker` therefore distinguishes
"read it, nothing said" from "could not read it at all", a difference previously flattened
to `null`, which is why half the evidence was invisible.

**The Find Roles pipeline** (`findAndSaveRoles` in `app/actions/roles.ts`): one web-search call returns a JSON array of roles → the URL-verification and fit-scoring block lives in `lib/ingest-roles.ts` (shared with the crawler and role search below), which liveness-checks every `job_url` in parallel (`lib/verify-url.ts` — only definitive 404/410 counts as dead; 403s/timeouts pass through, job boards block bots), saves dead roles with status `"Posting Closed"` and skips fit-scoring for them, and saves live ones as `"New"`, `scoreFit`-ed in parallel. Results are also cached per-company in `discovered_roles` (cache-first unless `force`).

**Role-first discovery**: `app/actions/role-search.ts` searches for roles by title
and by GTM tool stack (`titleQueries` / `stackQueries` in `lib/search-criteria.ts`)
rather than by company, so companies that never appear in funding news still
surface. How many queries run is decided by `planQueries` in
`lib/search-criteria.ts` from the user's optional search ceiling: with a ceiling
set, `pickQueries` strides the enumeration down to it (advisory — the model
decides what to run) and that same number becomes `callWithWebSearch`'s
`maxSearches`, which sets the `web_search` block's `max_uses` and is the actual
ceiling on billed searches; with no ceiling the full list is offered and
`max_uses` is `MAX_QUERY_MULTIPLIER ×` the query count, a runaway rail rather
than a ration. A stored ceiling below 1 is ignored with a warning.
`maxSearches` is opt-in; the discover, roles, and crawler
callers omit it and are uncapped. Both the sent list and the searches Claude
actually issued are logged. Results cache
in `role_searches` per family and route through the same `lib/ingest-roles.ts`
path as the crawler. The Discover tab has two modes: by company (funding) and
by role.

**Company mode's windows are two independent lists** in `lib/discovery-windows.ts`, and
conflating them is the bug that was just fixed. `FETCHABLE_RANGES` (`7d`, `30d`) is what
the buttons search — one button each, both always visible, each billing its own Claude
run. `PINNED_CHIPS` (`7d`, `30d`, `3m`) is what the filter chip row charts, always shown
even at zero. A chip ONLY slices already-loaded results: selecting one never fetches and
never changes what a button will fetch. `3m` is charted but deliberately unfetchable, and
`6m`/`6-18m` are legacy — their cached results stay visible and filterable, but nothing
can re-fetch them. The invariants between the lists (every fetchable range is also
charted; nothing sits in two lists; the fetchable set is exactly `7d`+`30d`) are pinned by
`lib/discovery-windows.test.ts`, so widening what one click can bill takes a failing test
rather than a quiet line. Wider windows are NOT free: the search prompt is never told what
is already cached and dedupe happens at read time in `getAllDiscoveredStartups`, so a
wider window re-finds and re-bills companies you already have — and it re-tags them to the
newer window, which shifts the chip counts.

**Status/filter machinery is USER-EDITABLE**, stored as one `app_settings` row under `JOB_STATUSES_KEY` and resolved by `resolveStatuses` in `lib/job-statuses.ts`. To change the list, edit it on `/settings` — do not touch code. `jobs.status` stores the **key**, which is immutable; the label is presentation only, so a rename rewrites no rows. `JobStatus` in `lib/types.ts` is now just `SystemStatusKey` — the three statuses code reads or writes by name (`New`, `Applied`, `Posting Closed`), one of which (`New`) is matched in raw SQL (`lib/crawler.ts`, `lib/removed-titles.ts`) and is the column default in `db/schema.sql`. Those three cannot be hidden or deleted, and `New` is never a reassignment target. They CAN be renamed — that is the whole reason key and label are separate, and the editor's help text promises it. A rename edits the **label** only: their keys never change, no row is rewritten, and nothing may be added that blocks a rename or issues an `UPDATE jobs SET status` to carry one through. The `STATUS_STYLES` badge map lives in `components/RolesTable.tsx` and **must stay under `components/`**: `tailwind.config.ts` scans `./app/**` and `./components/**` only, so an arbitrary-value class in `lib/` is never generated and renders unstyled through a green build. A test pins that.

**Caching pattern**: Discover, Roles, and Insights all cache Claude results in their `*_cache`/`discovered_*` tables and serve those on re-query — API calls only happen on new searches or forced refreshes.

**Tracking and the crawler**: `watchlist` rows with `tracking_enabled = true` are
crawled on a recurring schedule (`crawl_interval_days`, default 7).
`lib/crawler.ts` tries a plain HTTP fetch of `careers_url` and extracts roles
from the stripped text with a non-search Claude call; if `lib/page-extract.ts`
detects a JS-rendered ATS shell it falls back to the `web_search` path. The tier
that worked is remembered in `crawl_method`.

**ONE COMPANY PER REQUEST since 2026-08-18.** The `crawler` cron service calls
`app/api/cron/crawl-next/route.ts` — guarded by `CRON_SECRET` — in a bounded
shell loop (30 iterations), and each call crawls exactly ONE due company and
reports whether more remain. `app/api/cron/crawl/route.ts` (the old batch route,
`DEFAULT_BATCH_LIMIT` = 3) still exists and still works, but NOTHING CALLS IT: it
is kept as a one-setting rollback and should be deleted once the loop has proven
itself. `DEFAULT_BATCH_LIMIT` therefore governs nothing in production — do not
reason about throughput from it.

**The real ceiling was never that constant.** Railway's edge closes a request
that transfers no data after 300 seconds (15 minutes only while data keeps
flowing). The batch route works silently and answers at the end, so it got 300s —
which at a MEASURED worst-case crawl of 91.2s is 3.29 companies. That, not the
120s guess in the old comment, is where the 3 came from. Shrinking the request to
one company makes the unit of work and the unit of failure the same, so capacity
is now bounded by how many times the loop runs, not by a timeout.

Durations are measured, not assumed: query `crawl_runs` (`started_at`,
`finished_at`) rather than repeating a figure from prose — fetch tier p50 2.8s,
search tier p50 ~65s, max 91.2s over n=12 as of 2026-08-17. The file you are
reading said `DEFAULT_BATCH_LIMIT` was 10 for weeks while the code said 3, and a
plan was written on top of the wrong figure; the same file then carried a
60–120s crawl estimate nobody had ever measured. Full design, measurements and
caveats: `docs/superpowers/specs/2026-08-17-crawl-throughput-design.md`.

**A careers page dead for a week stops being tracked.** `lib/dead-tracking.ts`
plus `watchlist.failing_since` (migration 010): the clock starts on the first
failure of a run and is cleared by any success, and after
`DEAD_PAGE_GRACE_DAYS` (7) with at least `DEAD_PAGE_MIN_FAILURES` (2) the row is
set `tracking_enabled = false`. Two failures minimum because at a 14-day interval
a single failure is the only evidence available at day 7, and it is as likely a
timeout as a dead page. `"empty"` is NOT a failure — a page that loads and lists
nothing is working. This REPLACED a proposed exponential backoff, deliberately:
backing off delays the very evidence that proves a page is dead. A manual
tracking toggle clears `failing_since` in both directions, which is the only
thing distinguishing "the crawler gave up" from "the user switched it off" —
`components/Watchlist.tsx` renders different copy for each, and
`lib/crawl-health.ts` announces the dropped count above the fold because the
`Not tracked` section is COLLAPSED by default and the notice was otherwise
invisible.

**Roles are
never DISCOVERED through ATS vendor or job-aggregator APIs** — the HTML path
works on any careers page, including custom ones and vendors nobody integrated,
and that generality is the point. Link REPAIR is the one narrow exception; see
below.

**Job links rot, and half of them were second-hand.** `checkJobUrl`
(`lib/verify-url.ts`) ran once at ingest and nothing looked again, so closed
postings sat in the table reading "New" indefinitely. Separately, the extraction
schema asked only for `job_url` with no preference, so the model returned
whatever the search engine ranked — 29 of 61 rows were ZipRecruiter/Built
In/Lensa links, which outlive the posting they copy. Both are now addressed:
`roleExtractionSchema(persona, buildingConcept, buildingUpside)` asks for the employer's own application URL, and
`repairJobLinks()` (`app/actions/link-health.ts`, the "Check links" button)
re-checks every open role. It costs no Claude tokens.

Repair resolves a company's board through the vendors' PUBLIC, unauthenticated
board endpoints (`lib/ats-boards.ts` + `lib/resolve-job-link.ts`) — the
deliberate, narrow exception to the rule above, permitted for link resolution
ONLY and never for discovery. **Every vendor in `BOARD_VENDORS` was
control-tested with a nonsense slug before being added, and nothing may be
added without that test** — two candidates failed it. `jobs.ashbyhq.com/<slug>`
returns 200 for ANY slug because it is a client-rendered SPA (a probe reported
16/16 companies resolved when the truth was 4/16; Ashby is in the list only
because its API is honest even though its HTML is not). SmartRecruiters'
postings endpoint returns 200 with an empty envelope for companies that do not
exist, and is excluded. Absence is therefore checked TWICE, by status and again
by response SHAPE, because each gate alone has a documented way to be fooled.
Workday is excluded for an unrelated reason: its per-tenant site name cannot be
derived from a company name.

Two more traps are pinned by tests. An EMPTY board is not an absent role —
Asseti keeps an empty Breezy board while hiring eight roles through Workable —
so the search continues past one and an empty board can never close anything on
its own. And hosts are matched on a dot boundary in `lib/job-link.ts`, since a
substring check reads a ZipRecruiter link carrying `?utm_source=lever.co` as
the employer's own.

The pass will NOT close a role merely because the employer's board stopped
listing it, even though that is how most of these actually die. The board is
found by GUESSING a slug from the company name, so a collision would close a
live role against a stranger's board. Those rows are reported with their own
`Move to Out` button — per row, plus a select-all once a group has more than one
— rather than handed to the table's bulk status control, which sat far enough
down the page that clicking "select" read as a button that did nothing. The
report distinguishes three reasons (`UnclearReason`, `lib/link-report.ts`),
because one sentence for all three was false for two of them: `empty` (a board
matched the company's name but lists nothing), `ambiguous` (several postings
could be this role), and `unresolved` (no employer board found at all —
previously a bare COUNT in the summary line, so those rows could be counted but
never seen or acted on). None of those three is ever auto-closed; every board behind them was
found by guessing a slug, so the row wording hedges once and the buttons carry
no second warning.

**What DOES auto-close, since 2026-09-07: a read-slug `absent`.** When the
vendor and slug were READ out of the stored URL (`verifyPostingLink`, not the
guessing `resolveEmployerLink`), the board being asked is certainly the
employer's, and its answer that the posting id is gone AND that nothing on it
resembles the title is evidence, not a guess. It reports as `closedAbsent`,
separate from `closedUnlisted`, because two boards found two different ways are
two different strengths of evidence. Nothing else catches these: Greenhouse
302s a removed posting to its board root, so `checkJobUrl` follows the redirect,
sees 200 and calls the link live — four sampled production rows were all in that
state and ~18 sat as New indefinitely. The argument that previously blocked this
("closing also marks a role never-live and hides it") was FALSE and was checked
before the change: the write is a status and nothing else, `never_live` is
ingest-time provenance, and `partitionNeverLive` hides on `never_live` rather
than on status, so a role closed here stays visible under Out. A row closed this
way also skips the trailing 404 check, which would otherwise write the same
status twice.

**`checkJobUrl` itself closes on TWO definitive answers, not one, since
2026-09-07.** A 404/410 is the obvious one. The other is a redirect that LANDED
ON A LISTING: a closed req is commonly 30x'd to the careers page it came from,
which answers 200, and `checkJobUrl` set `redirect: "follow"` and then read only
`res.status` — so it called those live. Measured: Samsara's
`/company/careers/roles/7974118` lands on `/company/careers/roles` while a live
sibling id redirects nowhere, and the same company's dead
`job-boards.greenhouse.io` link hops CROSS-HOST to that same listing. That hop
is why `redirectVerdict` (`lib/redirect-verdict.ts`) compares the posting
IDENTIFIER rather than asking whether the landing page is an ancestor of the
link — an ancestor test cannot see across hosts. It answers `landed-on-listing`
only when the identifier is gone AND the landing page names no posting at all;
a CHANGED identifier is `moved` and closes nothing, because that is evidence of
neither life nor death. A posting slug carrying no digit (`/careers/director-gtm-business-operations`)
is invisible to the rule rather than at risk from it — deliberate, since the
predicate that decides "this segment names a posting" also decides whether a
role gets closed AND hidden. The rule runs only for a status that would
otherwise have read live; an ambiguous status stays ambiguous however it
redirected.

**A role that was already dead when we found it is hidden, not deleted.**
`ingestRoles` closes a role on two signals — `dead` from `checkJobUrl` (a
definitive 404/410, or a redirect that landed on a listing; see the paragraph
above), or `unlisted` (the employer's guessed board does not list the title) —
but only the FIRST sets `jobs.never_live`. `partitionNeverLive`
(`lib/never-live.ts`) drops those rows in `getJobs`, which removes them from the
`/roles` table and from BOTH tiles at once, since `tileCounts` derives from the
same array; the count comes back as `hiddenCount` and renders as one muted line
under the tiles. The rows must never be DELETED: `ingestRoles` dedupes against
every existing row for the company regardless of status, so deleting them makes
the next Find Roles run re-find, re-verify and re-insert the same dead postings
permanently. Hiding on `unlisted` was rejected for the same reason
`repairJobLinks` refuses to CLOSE on it — the board is found by guessing a slug,
and a collision would disappear a live role with no way to get it back. A third
status, `"unknown"` (403s, timeouts, rate limits — the COMMON outcome), sets
neither: those roles are stored `New` and scored normally, and a test pins that,
because the mutation that treats anything-but-live as dead passed the whole
suite before it existed. This is deliberately NOT a fourth `SystemStatusKey`:
"never live" is a provenance fact stamped at insert, not a workflow state, and a
new system status would collide with `resolveStatuses`' `hidden: false` rule and
force a third `StatusBucket` through `bucketFor`, `tileCounts`, the Open/Out
filters and `link-health.ts`. The column ships as `db/migrations/008_never_live.sql`
and NOT through `db/apply-schema.mjs`, which would re-create the `insights_cache`
table that `006_drop_insights.sql` dropped. Design:
`docs/superpowers/specs/2026-08-17-never-live-roles-design.md`.

**The résumé prompt reads the posting.** `loadJobForTenant` selects `posting` and
`buildThemePrompt` renders `requirements` / `niceToHaves` as their own lines — until
2026-09-07 it selected eight columns, `posting` was not among them, and EVERY JD the app
had ever read was invisible to the feature that needs it most. A role with no JD is not
refused (the user can read the posting in a browser) but says so, on the row as a `no JD`
chip and on the tailor screen; `hasPostingBeenRead` (`lib/posting-detail.ts`) is the one
definition, shared with the enrich queue. The expanded row leads with **What the posting
asks for**, above everything the app inferred, because the fit rationale is this app's
opinion and only that block is the employer speaking.

**Résumé tailoring** (`/resume`, admin-gated) turns a tracked role into a résumé
selected from the checked-in career record — never freely generated text; see
`docs/superpowers/specs/2026-08-24-resume-builder-design.md` for the full
data model (`content/resume.json`'s bullet pool, `selectBullets()`,
`tailored_resumes`). The "Tailor resume →" entry point lives on the
**collapsed** `/roles` row itself (`components/RolesTable.tsx`, in the badge
strip next to the status dropdown) — it used to be inside the expanded row
detail only, which is easy to miss; don't move it back there without a reason.
Export is `window.print()` behind `print:hidden`/`print:p-0` classes added to
`app/layout.tsx`, `app/resume/page.tsx`, and `TailorPanel.tsx` — nothing hides
app chrome (nav, page header, buttons) at print by default, so a NEW page that
calls `window.print()` needs the same scoping or it captures the whole app
shell, not just its own content. The rendered résumé (`ResumeDocument.tsx`'s
`<doc-page>`) is `contentEditable` — bullet text can be clicked and edited
directly in the browser, matching the design system's own stated intent — but
edits are **not persisted by typing them**: nothing captures them back into
React state, so "Regenerate" or a reload discards them by re-setting the HTML
from the algorithmic selection. That's deliberate, not an oversight; Google
Docs export is select-all-and-paste, not an API integration. Since the
saved-résumés work below, **Save** is the one thing that makes an edit
durable — it reads the live DOM once, at that moment, and writes a frozen row;
everything in this paragraph still describes the DRAFT screen between saves.

**Saving a résumé is a SEPARATE table from tailoring one, and the distinction is
the whole feature.** `tailored_resumes` is the working DRAFT — one row per
(tenant, job), upserted by Regenerate, holding `{themes, selection, overrides}`
and never expiring. (Regenerate itself writes only `{themes, selection}`, so
`overrides` is a MAXIMUM shape, not an invariant: every reader must default the
absent key to `{}`.) `saved_resumes` (migration 016) is the ARCHIVE — one row per
explicit Save, many per job, holding frozen sanitized HTML that is mounted as
stored and **never re-rendered through `renderBody`**. Consequence worth knowing
BEFORE filing a bug: a saved row legitimately looks stale against the current
design, and the older it is the more it will. On 2026-09-08 a row saved the day
before still showed the tagline the design sync had removed, at a
`/resume?savedId=…` URL, and that was read as the removal not having shipped.
Check `render.js` and the render fixture, not a saved row, when asking whether a
design change is live. Re-rendering would
silently apply today's career record and today's selection rules to a document the
user saved as final. "Save as new version" on a saved résumé writes a NEW row and
never overwrites the one open. `job_id` is `ON DELETE SET NULL`, so an archived
résumé outlives the tracked role it came from; `role_title` and `company` are
snapshotted onto the row for exactly that reason, which is why the draft screen
withholds Save when it could not read the job rather than storing `""`.

**A saved row also records HOW it was built (`content jsonb`, migration 021), and
that is what makes it re-editable.** It holds the same `{themes, selection,
overrides}` the draft does — the **BASE** selection, never the effective one:
`loadResumeContext` returns both (`app/actions/resume.ts`) precisely because the
merged view cannot be un-merged, and storing the effective selection would
re-apply every override on the next `effectiveDocument` pass. `content` is
therefore read SERVER-side and never accepted from a caller, which is why there
are two save actions rather than one: `saveResumeFromDraft` reads
`tailored_resumes` itself, while `saveResumeAsNewVersion` copies the SOURCE row's
content forward and must never reach for the draft (that button captures a frozen
row's DOM, so attaching the draft's selection would produce a row whose `html` and
`content` describe different documents). The column is nullable with NO default so
a pre-021 row stays distinguishable from one saved with an empty selection — the
same rule `jobs.posting` and `page_margin` follow. `listSavedResumes` selects
`(content is not null) as has_content`, a BOOLEAN, never the payload: the archive
list renders every live row in the tenant, and `content` carries the full
selection plus `overrides.text`, which is arbitrary rewritten bullet prose. That is
the reason `html` is already excluded from the summary.

**Editing a saved résumé CHECKPOINTS the draft it replaces, and the ordering is
the safety property.** `restoreSavedVersion(savedId)` (`app/actions/`) renders the
current draft via `renderDraftHtml` (`lib/draft-render.ts` — the one place
`effectiveCareer` → `effectiveDocument` → `renderBody(doc.career, …, {rootStyle})`
is composed outside the client), writes it to the archive as `kind = 'checkpoint'`,
upserts the saved row's `content` over `tailored_resumes`, THEN demotes older
checkpoints, then appends a marker turn to `resume_chats`. Every one of those
orderings is load-bearing: a failed checkpoint insert must return before the
upsert or the draft is destroyed with no copy, and the demotion must come AFTER a
successful upsert or a failed restore still costs an earlier checkpoint its
30-day window. It takes `savedId` and NOTHING else — RLS checks `tenant_id` but the
FK to `jobs` bypasses row security, so a client-supplied `jobId` would let a caller
key a row to another tenant's job. `markerSaveError` is returned SEPARATELY from
`error` (the `TurnResult.transcriptSaveError` precedent): the restore has already
committed, and a caller that offers a retry writes a second worthless checkpoint
and demotes the real one. `restoreWouldChangeNothing` suppresses the checkpoint
when the draft already equals the row being restored — without it, a back-navigate
and a second click writes a junk checkpoint and drops the only copy of the original
draft to 3 days. Note that restoring IS a re-render against today's record, which
the archive forbids for saved rows and permits here only because it produces a new
draft: `render.js` drops unknown bullet ids silently and drops a whole ROLE when
none survive, so a deleted overlay bullet can make a role vanish. The confirm says
so.

**Retention is TIERED, and only the stamping knows about it.** 60 days for every
deliberate Save (all of them, not just the newest), 30 for the newest checkpoint
per job, 3 for superseded ones; the live `tailored_resumes` row never expires and
is not a tier. `EXPIRED_PREDICATE` / `LIVE_PREDICATE` are unchanged — they compare
`expires_at` against `now()` and nothing else, which is what keeps the
complementary-pair test meaningful. Demotion is
`least(expires_at, now() + interval …)`: an unconditional stamp would EXTEND a
checkpoint already older than the new window, and the `kind = 'checkpoint'` filter
is equally load-bearing or it demotes 60-day saves to 3. `kind` is a COLUMN rather
than a match on the `Checkpoint · <date>` label, for the same reason `jobs.status`
stores an immutable key: a label is presentation the user can type. Consequence
worth knowing: restoring puts an indefinitely-held draft onto a clock, and deleting
the newest checkpoint leaves the previous one at 3 days with nothing to re-promote
it.

**The résumé chat turns the tailored document into a conversation, and `effectiveCareer()` (`lib/effective-career.ts`) is the ONE record it and the renderer both see.** `app/resume/page.tsx` must never import `content/resume.json` for rendering: the client renderer is vendored (`render.js:172`), resolves an override's ids against whatever record it's handed, `.filter(Boolean)` drops what it can't find, and `:173` drops the whole ROLE when nothing survives — a server that merged overrides into one record while the client rendered the shipped one would fail exactly there, silently. `lib/effective-document.ts` is the other resolution that must stay singular: the ONLY place a stored override becomes a rendered document — it re-derives the selection through `selectBullets` (so `themes`, `taper`, `lead` and `positioning` reach the renderer at all), overrides `rules.compressAfter` on a freshly cloned record, and folds in the bullet-id overrides `lib/effective-selection.ts` resolves. Both `sendChatTurn` and `loadResumeContext` go through it, so a page reload shows the same document a chat turn just produced rather than the stale unmerged base. Its rule is "an own property in the override wins regardless of its value" — an empty `bullets[roleId]` array means "this role shows no bullets," not "no override, fall back to base."

**Authored text — a chat `set_text` value or a proposed overlay bullet — goes through `sanitizeBulletText` (`lib/resume-text.ts`) at THREE separate boundaries: operation validation, the `effectiveCareer` merge, and `sanitizeResumeHtml` on Save.** The reason for three, not one: `render.js:182` emits `'<li>' + b.text + '</li>'` with NO escaping (the career record carries `<strong>` tags that must survive), and that output reaches the DOM through `dangerouslySetInnerHTML` on the CLIENT (`ResumeDocument.tsx`), where the Save-time sanitizer has never run — a model-authored bullet is a script tag away from executing in the user's browser at any boundary that skips this. It ESCAPES rather than strips, so a blocked edit stays visible as inert text instead of silently vanishing, and because escaping only ever grows text (`"<".repeat(600)` becomes 2400 characters), it caps the SANITIZED length too, not just the raw input.

**In `lib/resume-sanitize.ts`, `allowedAttributes.div: ["style"]` and `allowedStyles.div` are ONE change and must never be edited separately.** `sanitize-html`'s `filterCss` returns a div's style declarations completely UNFILTERED when neither the tag key nor `*` exists in `allowedStyles` — so the attribute grant without a matching style rule opens arbitrary inline CSS on every div the renderer emits. The chat closes the same class of bug from the other direction with `hasOwnProperty`/null-prototype guards (`lib/resume-ops.ts`, `lib/resume-design-tokens.ts`'s `SPEC_BY_NAME`): `selection.bullets["constructor"]` or `SPEC_BY_NAME["constructor"]` resolves the inherited `Object` — truthy, so a `|| []` fallback never fires and `.indexOf` throws, turning model output that happens to name a prototype property into a 500.

**Design token overrides ride on the `.rsm` div and are captured by `useResumeCapture` for free; the page margin is not.** It's an attribute on `<doc-page>` itself, outside `.rsm`'s captured `innerHTML`, so it needed its own column (`saved_resumes.page_margin`, migration 020) and its own default constant (`DEFAULT_PAGE_MARGIN`, `lib/resume-download.ts`), rather than riding the existing capture path.

**The vendored `render.js` now carries two DATED divergences from its source, both from 2026-09-07, which a re-sync would silently revert** — the same trap the design-token CSS files above already record. One is the bullet-ordering rule: tail bullets always sink and the rest rank by theme weight with priority only as the tie-break, because a weight-first sort with no such rule promotes award/tail bullets to the top of a role — this needed a new DATA field, `bullets[].tail`, not just a code change. The other is `rootStyle`: the chat's per-document design-token overrides are spliced onto the `.rsm` div's own `style` attribute inside this function, because that is the one place a value rides into `saved_resumes` via `useResumeCapture` for free — set on `<doc-page>` itself, or in a `<style>` tag, it looks identical on screen and is silently lost on Save.

**The chat uses `complete({ jsonSchema })`, and `completeDetailed` rather than `complete`, because `complete()` discards `stopReason`.** `callStructured` (`lib/model-call.ts:134-139`) takes NO schema despite its name — it's a plain completion for the page-text extraction path. The chat needs `stopReason` because a response truncated at `max_tokens` still parses into a valid-LOOKING object with operations silently missing, which is indistinguishable from a genuinely short turn without it.

**An operation that writes an override has not necessarily changed the document, and the difference is the most expensive thing this branch learned.** The first implementation wired FIVE of the fourteen operations to nothing — `set_themes`, `set_lead`, `set_taper`, `set_compress_after` and `request_rule_change` were validated, billed, persisted, reported to the user as done and advertised to the model in a fixture-pinned prompt, while changing no pixel — and it passed fifteen individual task reviews. The cause was structural: `selectBullets` had one production call site, invoked with `themes` alone, so any override that was not a bullet-id list had no path to the renderer; and every test asserted the OVERRIDE OBJECT rather than the rendered output, so nothing could see it. `lib/effective-document.ts` is the hop that was missing. **A test for a chat operation asserts the rendered document — the `<li>` count, the role blocks, the coverage numbers — never the override it wrote.** Asserting the intermediate proves the operation ran, which was never in doubt.

**Two consequences of that, both easy to undo by accident.** `set_lead` works on the FIRST role only, because `render.js:73` is literally `if (i === 0 && opts.lead)`; `validateOperation` therefore refuses a lead on any other role, and "fixing" that refusal without changing the vendored renderer would recreate an inert operation that reports success. And `applyOperations` returns `changedDocument` (`lib/resume-ops.ts:391-400`, a `NO_DOCUMENT_CHANGE` set read with `hasOwnProperty`) separately from `applied`, because `applied` also carries `request_rule_change` and `propose_career_bullet` — neither of which touches the document. `ChatPanel` gates its re-render on `changedDocument`, not on `applied.length`: re-rendering re-sets `dangerouslySetInnerHTML` and discards unsaved hand edits, so gating on the wrong one destroys work for a turn that changed nothing. `Accept` carries its own confirm for the same reason, and deliberately asks AFTER the overlay write, since accepting a bullet is durable and worth keeping even when the user declines to lose their edits.

**`request_rule_change`'s output is persisted, or the escape hatch is theatre.** `ruleRequests` is stored on the assistant message in `resume_chats.messages` next to `proposals` — it was collected and dropped on the floor in the first implementation, which made the one operation whose entire purpose is to capture something for later capture nothing. Related: `effectiveCareer` clones `rules` ARRAYS INCLUDED, not just the object, because `taper` is now user-settable through the chat and an array push into the process-wide `content/resume.json` import would corrupt every later request in that process.

**Coverage is computed per request against the RENDERED roles only, and never stored.** The vendored `coverage()` in `render.js` audits the whole bullet pool, but `renderBody` only draws roles up to `compressAfter` — measured on the shipped record, that's 23 bullets selected against 16 actually rendered. `coverageReport` (`lib/resume-coverage.ts`) narrows BOTH the career record and the selection to rendered role ids before calling `coverage()`; narrowing only one — a narrowed career against the full, unnarrowed selection — inflates the denominator with bullets from roles that never render. Measured on Task 2's review with `themes: ["systems","data","ops"]`: narrowing the record alone computed `strength` 0.5652, against the correct rendered-only value of 0.8125 — a ~25-point error.

**`sendChatTurn` returns `transcriptSaveError` as a field SEPARATE from `error`**, because the document save and the transcript save are two writes with no shared transaction: reporting a transcript failure as `error` would make a caller retry a change that already saved.

**Edits are captured only on Save, and the capture is `docPageEl.innerHTML`
with the page guides stripped** (`components/resume/useResumeCapture.ts`). Two
traps, both invisible until after a row is written: capturing the `.rsm` div's
innerHTML instead of its parent's loses the root that `document.css` scopes the
entire design to, and the saved résumé then renders as unstyled body text; and
`rsm-page-guides.js` appends its overlay INSIDE `.rsm` while its styles go to
`document.head`, so the guide nodes travel with a capture and their styling does
not — they would freeze stale break markers into the row and print as literal
"Page 2" text. The sanitizer (`lib/resume-sanitize.ts`) drops them again
server-side. That allowlist is derived from three sources, not from
`renderBody`'s tag output alone: the career record reaches the page through an
UNESCAPED bullet path carrying `<strong>`, `contentEditable` adds `<br>`/`<b>`/
`<i>` that the renderer never emits, and `render.js` puts an inline
`margin-bottom:0` on the last section whose loss is a page break. A checked-in
fixture pins the shipped record's full render through the sanitizer.

**Retention's two SQL comparisons live in ONE place** (the day counts are tiered —
see the checkpoint paragraph above; this is about the comparisons, which the tiers
did not change). `lib/resume-retention.ts` exports `EXPIRED_PREDICATE` (`<=`) and
`LIVE_PREDICATE` (`>`) as strings, plus the `isExpired` JS twin, because the
comparison is expressed in SQL at three call sites where no vitest test can
execute it — retyping either operator is the `compFloor` `>`-not-`>=` hazard
this file records, and a test asserts the pair stays complementary. Three
mechanisms enforce the window, deliberately redundant: the
`CRON_SECRET`-guarded `app/api/cron/purge-resumes` route (primary, over EVERY
tenant regardless of account status — a suspended user's storage must still
expire, which is why it uses `listAllTenantIds` and not
`listCrawlableTenants`), an opportunistic per-tenant purge inside
`listSavedResumes` (so an active user's retention survives the cron being
down, which this file records happening for days unnoticed), and a
`LIVE_PREDICATE` filter on both reads so an unpurged expired row is never
shown. All three are kind-agnostic and purely predicate-driven, which is what
let the tiers land without touching them. What retention does NOT cover: the
non-expiring `tailored_resumes` draft row, Railway's own database backups, and
any file the user has downloaded.

**Every raw statement against `saved_resumes` passes the tenant id as
`rawQuery`'s THIRD argument.** `runAsTenant` sets an AsyncLocalStorage value,
not the Postgres GUC, and `app_rw` is `nobypassrls` — so a tenant-table
statement with no tenant set matches zero rows and returns no error. Adding the
table to `TENANT_TABLES` protects the query BUILDER only and does nothing for
raw SQL. `DESIGN_VERSION` in `lib/resume-download.ts` is stamped on every saved
row and must be bumped BY HAND whenever anything under
`public/resume-design/tokens/` changes; a row whose version differs from the
current one is labelled "saved against an earlier document design" rather than
silently re-styled.

**The three `public/resume-design/tokens/*.css` files are no longer
byte-identical to the ported Claude Design source, and that's deliberate,
not drift.** The design spec above describes them as "copied near-verbatim
and byte-verified" — true as of the initial port, false as of 2026-08-28.
Real print defects surfaced once an actual tailored résumé (multi-bullet
roles, not the design system's own shorter sample content) was tested
end-to-end, and fixing them meant diverging from the vendored CSS:
`document.css`'s `.rsm-role` no longer carries `break-inside:avoid` — that
rule assumed every role fits in whatever space is left on the current page,
which broke whenever the first role after the masthead/summary didn't fit,
jumping the WHOLE role to the next page and stranding 300-400px of blank
space instead of the small orphaned-header gap the rule meant to prevent.
Replaced with `break-after:avoid` on the role head/org plus
`break-before:avoid` on the first bullet, so the header can never be
stranded alone but later bullets can flow onto the next page. **That pass
did not actually fix the reported defect, and this file credited it with
doing so for a day.** The rule that decided where the document broke was one
line ABOVE it — `.rsm-section{break-inside:avoid}`, untouched since the
original port and never disputed, so it survived the re-sync unread. See the
section-fragmentation paragraph below.
`.rsm-bullets` switched from `display:flex;flex-direction:column` to plain
block flow (`margin-top` instead of flex `gap`) — `doc-page.js`'s own usage
docs explicitly warn that flex/grid containers don't fragment cleanly across
print pages, which is exactly what a bullet list now needs to do since the
break-inside change above. `spacing.css`'s `--rail` went from `96px` to
`132px`: the longest section-label word ("Certifications") measures ~123px
at `--type-section`'s 12px/0.2em tracking, so no single word fit — combined
with `doc-page.js`'s global `text-wrap:balance` on headings, that forced a
literal mid-word break ("PROFESSIONA"/"L") instead of a normal word-boundary
wrap.

**The re-sync happened on 2026-09-08, and it is the model for the next one.**
The design system carries a `_repo-sync/` folder holding exactly the files this
repo vendors, and `_repo-sync/COMMIT-NOTES.md` states the ownership rule:
`resume.json` and `themes.json` are edited in the REPO and mirrored up, while
`render.js`, `styles.css`, `tokens/` and `doc-page.js` are edited in the DESIGN
SYSTEM and copied down. Editing the vendored copy — which this repo had been
doing — is writing to the wrong end. Read it through the `claude-design` MCP
(`DesignSync`, project `999f7fe8-e8bc-449f-9121-0f2d8dc9730c`); if that server
will not connect, say so rather than porting from a screenshot.

What the sync brought down: the masthead is now the name plus ONE wrapping mono
line of contact points with tinted `·` separators, and **no tagline at all** —
the source's own comment gives the reason, that the summary below already
carries the positioning and saying it twice reads as padding. Also `--ink-500`
darkened to 0.545 so `--text-muted` clears 4.5:1 on the 10px metadata.

What was KEPT against the source, and why the earlier read of "these are
obsolete" was wrong: the source sets `break-inside:avoid` on `.rsm-role`
because "the tallest role is ~375px against a 925px page". True of a role in
isolation and beside the point — the question is whether it fits in what REMAINS
of the page, and a role landing after the masthead gets pushed whole onto the
next one, stranding 300-400px. This app also lets the chat set the taper, so
roles can exceed the source's assumption. That divergence and its consequence
(block-flow bullets, because `doc-page.js` documents that flex containers do not
fragment across print pages) both stay, as does `--rail` at 132px.

One NEW divergence the sync forced: the source's separator class is bare `sep`,
and `lib/resume-sanitize.ts` allows only `/^rsm(-[a-z0-9-]+)?$/`, so it is
stripped from every SAVED résumé while looking correct in the draft. Renamed to
`rsm-sep` here, and PUSHED UPSTREAM 2026-09-08 — to `_repo-sync/tokens/document.css`
and `_repo-sync/render.js` BOTH, since the CSS selects on the name render.js emits
and a rename in one alone leaves the separators untinted. No longer a divergence.

**`break-inside:avoid` on a box TALLER than a page causes the blank page it looks
like it prevents, and `.rsm-section` was that box.** The printed résumé put the
masthead and summary alone on page 1 and started Professional Experience on page 2,
leaving ~700px of white — the defect the 2026-09-07 role pass was thought to have
fixed. The engine does not keep an over-tall box whole: it pushes it to the next page,
finds it still does not fit, and fragments it there anyway, so the only thing the rule
buys is the gap above the push. At twelve roles that section is three pages tall.
`.rsm-section:has(.rsm-role){break-inside:auto}` exempts the one section whose height
is unbounded; Advisory and Education stay unsplittable, which is what the source's
rail-label argument actually protects — its concern was a two-row section stranded
from its label, not a three-page one. The rail label does not repeat on the
continuation page, correctly: it labels the section, not the page. **Measure this
class of defect, never read it** — `renderResume` to a file, headless Chrome
`--print-to-pdf`, then `pdftotext`/`pdftoppm`; no vitest test can lay out a page.
Before and after: 4 pages to 3, page 1 full. Corroboration that the CSS and not the
estimator was wrong: `rsm-page-guides.js` had been offering breaks between roles
inside that section since it was written, so the on-screen guide and the print output
had silently disagreed the whole time. Pushed upstream with the `rsm-sep` rename.
`lib/resume-print-breaks.test.ts` resolves the CASCADE rather than grepping for a
string, so a re-sync that restores the rule fails as loudly as one that blanket-removes
it.

**Removing the tagline made `set_text`'s `positioning` target inert**, so it was
removed rather than left to validate, bill, report success and change no pixel —
the failure this file already records five of. `summary` is the positioning
statement now, it is the only clearable slot, and the house-style rule
(`lib/house-style.ts`) requires it rather than accepting a tagline in its place.

**If this design system is ever re-synced again, the kept divergences above will
be silently reverted** — check `git log` on `public/resume-design/tokens/` and
`lib/resume-render/render.js` before trusting a fresh port. Any change under
`tokens/` also requires bumping `DESIGN_VERSION` (`lib/resume-download.ts`) by
hand; the sync took it to `2026-09-08b`, and the section-fragmentation fix below
took it to `2026-09-08c`.

**`public/resume-design/page-guides.js` (the vendored on-screen page-break
overlay) is not loaded — `components/resume/ResumeDocument.tsx` loads
`public/resume-design/rsm-page-guides.js` instead, a small app-owned
replacement.** The vendored version estimates page breaks by dividing
rendered height by page height alone, with zero awareness of
break-inside/break-after/break-before, so it drew its "PAGE 2" line between
a role's header and its bullets even after the fix above made the real
print output stop splitting there — a wrong on-screen indicator being worse
than none is what justified writing a replacement rather than just
deleting it. `rsm-page-guides.js` walks `.rsm-role`'s actual structure and
only offers a break where `document.css` actually allows one; it's still an
estimate (font-metric rounding and orphans/widows aren't modeled), so
Print / Export PDF remains the ground truth for anything this guide and the
real output might disagree on.

## Closed: the three career-agnostic gaps (2026-08-18)

All three were closed in one pass. Recorded rather than deleted, because each one's REASONING still constrains the next change.

- **Company-name variant merging — closed by `companyIdentityKey`.** The rule is: lowercase and collapse (via `normalizeCompanyName`), split on punctuation and whitespace, drop legal-form tokens (`inc`, `llc`, `ltd`, …), drop duplicates, sort. Two names merge exactly when built from the same set of meaningful words, which is what makes it order-independent — and order-independence is REQUIRED, since no ordering rule can call "RTX (Raytheon)" and "Raytheon (RTX)" equal. **What that knowingly accepts:** two different employers whose names are word-level anagrams ("Acme Health" / "Health Acme") would merge. That is the price, which is why merged spellings surface as `alsoKnownAs` on the card instead of vanishing. Two fallbacks are load-bearing and each has a test: a name made ENTIRELY of legal-form words ("Ltd") keeps them rather than keying to `""`, and punctuation-only input falls back to the normalized string — without either, every such row collapses onto one card.
- **Watchlist shows the hiring signal — closed by `db/migrations/012_watchlist_signal.sql`** (applied to production 2026-08-18 and verified: `app_rw` holds SELECT/INSERT/UPDATE, since migration 009's column-list revoke is `users`-only and a table-level grant covers columns added later). `watchlist` gained `signal text` and `extras jsonb not null default '{}'`; `TrackedCompany` carries both; `addToWatchlist` derives them through `watchlistSignalFields` (`lib/watchlist-signal.ts`). The six venture-shaped columns are now the FALLBACK, shown only for rows predating the migration. Two details that are easy to get wrong: that helper uses `||` rather than the read path's `??` (it is WRITING a fresh value, so a model returning `signal: ""` should still get a line composed from the legacy fields, whereas the Discover read path uses `??` because pre-`signal` cache rows have no such key at all), and `components/Watchlist.tsx` branches on `!c.signal` rather than `=== null` — a row read back before the migration lands has no such key, and a strict null check reads `undefined` as "has a signal" and hides the legacy tags too, producing a blank row instead of a degraded one.
- **Discover's dropped exclusion clause — closed by `HiringSignal.exclusions`.** It is a SECOND field rather than a longer `qualifier`, and the reason is specific: `qualifier` is also spliced into the example SEARCH QUERIES, where exclusion prose would turn a billed web search into a garbage query string. `exclusions` is prompt-only and never reaches a query. It resolves through `optionalText`, so `""` is a real stored answer (a signal that rules nothing out) rather than something the funding default quietly overwrites. The shipped value is the pre-genericisation prompt's own words, verbatim: "seed, pre-seed, and Series A rounds". It is threaded through `resolveHiringSignal`, both builders in `lib/hiring-signal-prompt.ts`, `lib/onboarding-prompt.ts`, and the onboarding edit form.

**What none of this changed: the career-neutrality guard still does not scan `hiringSignal`.** `PHRASES` in `lib/career-neutrality.test.ts` covers the eleven `Profile` career-TEXT fields; `hiringSignal`'s own strings — `name` ("funding rounds"), `qualifier`, the publication list, and now `exclusions` — were never in it and still are not. Those are career-specific values living legitimately in `lib/profile.ts`, so the guard would not fire on them anyway, but do not read a green guard as proof that the signal is career-neutral.

## History caveat

The repo was inherited from a previous owner (git history before `d2bed2d` contains his `.claude/skills/` job-search workflow and an accidentally committed `.env.production`). Don't resurrect anything from that era; this app is the multi-tenant, career-agnostic tool described above, not that owner's single-career job-search workflow.

**That `.env.production` is NOT a credential leak, and the history is safe to push or open-source.** Audited 2026-08-15: it is a `vercel env pull` scaffold, added in `a304725` and deleted in `165b2c0`, and its sensitive values are EMPTY — `ANTHROPIC_API_KEY` and the Supabase keys are zero-length, and `DATABASE_URL` and `CRON_SECRET` were never in it at all. Its one real value is a `VERCEL_OIDC_TOKEN` belonging to `chadholdorfs-projects` (the previous owner, not this one) that expired 2026-06-29. **Measure values before calling something a leak** — this file's alarming name alone drove a rotation and a "can never be public" claim that were both unnecessary, and the wrong conclusion was repeated across a whole session before anyone ran `git show`.
