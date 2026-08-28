# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Multi-tenant, career-agnostic, AI-powered job search tool. Next.js 14 (App Router) + TypeScript + Tailwind + Postgres + Anthropic API. Most backend logic is React Server Actions in `app/actions/`; the one exception is the secret-guarded cron route below. Every tenant's career domain — target titles, fit rubric, hiring signal, search-query vocabulary — comes from a per-tenant profile generated at onboarding (`lib/profile.ts`), not from a hardcoded GTM/RevOps default; see the profile paragraph in Architecture below. GTM/RevOps is still what the shipped `DEFAULT_PROFILE` renders as, because it is Tom Keefe's own career and that is what the pre-onboarding app's rendered prompt TEXT is a no-op against — it is a default now, not a ceiling. The one field that default does NOT carry is `fitBrain`, which ships empty and makes the app refuse rather than render anyone's career; see the profile paragraph below.

**The shared-password gate is GONE, and there is no middleware.** `middleware.ts`, `app/gate/` and `app/api/gate/` were deleted on 2026-08-17, along with the `GATE_TOKEN` variable on `web`. That gate was always labelled throwaway (`docs/superpowers/specs/2026-08-16-multi-tenant-auth-design.md` — revision 2; the 08-15 file is the superseded revision 1, kept only as a record) and it was removed once Google sign-in plus the pending-approval waitlist covered everything it did, because past that point it was pure redundancy that forced a shared secret on every invitee.

**What replaced it is per-surface, not global, so the coverage argument has to be re-made whenever a surface is added.** Middleware was attractive precisely because it covered Server Actions for free — those are RPC endpoints addressed by an ID that ships in the client bundle, so gating pages does nothing for them. Nothing covers them for free any more. The three standing invariants are: every `page.tsx` calls `requireActorPage()` (or `requireAdminPage()` for `/admin`); every exported server action refuses a session-less call, which `app/actions/auth-required.test.ts` asserts by importing each file in `app/actions/` and calling every exported function; and the only deliberately public surfaces are `/signin`, `app/api/auth/[...nextauth]` (the OAuth handshake) and the two cron routes `app/api/cron/crawl-next` and `app/api/cron/crawl` (a shared `CRON_SECRET` bearer check in `lib/cron-auth.ts`, failing closed). `app/page.tsx` holds no data and only redirects to `/discover`. The two actions on that test's `CRON_CALLED` exemption list were probed directly at removal time and refuse a session-less call anyway — they reach `resolveTenantId()`, which falls through to `requireActor()` outside a platform context. Adding a page without `requireActorPage()` is now an unguarded surface with no framework backstop, and only review catches it. (The Edge-runtime constraint that made middleware unable to do real auth still stands: it cannot reach Postgres, and Node-runtime middleware does not exist until Next 15.2.)

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

**One real defect the diff surfaced, in the DATA rather than the code, still unfixed:** the stored profile contradicts itself on the compensation floor. `fitBrain` and the `compFloor` setting both say $250K; the generated `weakFitTail` says "clearly below the **$275K** base threshold". Both numbers reach the model in one prompt. Fixing it means editing the profile on `/settings`, and it is the user's call which number is right.

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

**Compensation**: `salary_range` is stored verbatim as the posting wrote it and parsed at READ time by `parseSalaryRange` in `lib/salary.ts` — base preferred over OTE, so `$280K–$325K (base); $305K–$365K OTE` is a $280–325K role. The optional floor lives in `app_settings` under `compFloor`. It filters `/roles` on DISPLAY only (`lib/salary-filter.ts`: two independent toggles, both off by default; `ote` is its own bucket and is never hidden as "below") — no job is ever dropped or hidden at ingest because of pay. `scoreFit` receives both the posting's stated range and the floor. **The boundary is strict (`>`, not `>=`): a band whose top only REACHES the floor is below it** — `$150K–$200K` fails a $200K floor, `$177K–$221K` clears it. That rule lives in TWO places and they must not drift: `salaryBucketFor` (the display bucket) and `compScoringClause` + `aiGtmCompCarveOut` in `lib/fit-prompt.ts` (the scoring rule). Changing one alone produces a role the table hides while its fit score still reads 4 — and the carve-out needs it too, because it outranks the compensation clause. Because that changed `scoreFit`'s inputs on deploy rather than on an edit, `/settings` offers a one-time rescore gated on the `comp_scoring_rescored_at` stamp (`compRescoreOffer` in `lib/rescore-progress.ts`); the pass itself is `runRescorePass`, never a hand-rolled loop.

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
never seen or acted on). None is ever auto-closed; every board behind them was
found by guessing a slug, so the row wording hedges once and the buttons carry
no second warning. Only a definitive 404/410 closes anything, unchanged.

**A role that was already dead when we found it is hidden, not deleted.**
`ingestRoles` closes a role on two signals — a definitive 404/410 from
`checkJobUrl`, or `unlisted` (the employer's guessed board does not list the
title) — but only the FIRST sets `jobs.never_live`. `partitionNeverLive`
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
edits are **never persisted**: nothing captures them back into React state or
the database, so "Regenerate" or a reload discards them by re-setting the
HTML from the algorithmic selection. That's deliberate, not an oversight;
Google Docs export is select-all-and-paste, not an API integration.

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
stranded alone but later bullets can flow onto the next page.
`.rsm-bullets` switched from `display:flex;flex-direction:column` to plain
block flow (`margin-top` instead of flex `gap`) — `doc-page.js`'s own usage
docs explicitly warn that flex/grid containers don't fragment cleanly across
print pages, which is exactly what a bullet list now needs to do since the
break-inside change above. `spacing.css`'s `--rail` went from `96px` to
`132px`: the longest section-label word ("Certifications") measures ~123px
at `--type-section`'s 12px/0.2em tracking, so no single word fit — combined
with `doc-page.js`'s global `text-wrap:balance` on headings, that forced a
literal mid-word break ("PROFESSIONA"/"L") instead of a normal word-boundary
wrap. **If this design system is ever re-synced from Claude Design, these
three changes will be silently reverted** — check `git log` on
`public/resume-design/tokens/` before trusting a fresh port over what's
running in production.

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
