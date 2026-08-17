# Handoff: provider registry (step 1)

> **SUPERSEDED — step 1 shipped on 2026-08-17.** Start from
> `2026-08-17-after-step-1-handoff.md` instead. "The task" section below is
> DONE; do not implement it again. The **Traps**, **Settled** and **Errors made**
> sections are still accurate and still worth reading, which is why this file is
> kept rather than deleted.

Written 2026-08-17 at the end of a very long session, for whoever picks this up
next. The specs describe WHAT to build; this describes the ground you are
standing on, the traps that cost time today, and the decisions that are settled
so you do not relitigate them.

## Read first, in this order

1. `CLAUDE.md` — architecture, and the empty-error doctrine that governs every
   `{ error?: string }` in this repo.
2. `docs/superpowers/specs/2026-08-17-model-agnostic-design.md` — **revision 2**.
   Revision 1 was reviewed twice and rewritten; the "What revision 1 got wrong"
   section is the most useful part.
3. `.claude/skills/swallowed-string-errors` — the project skill. Two fresh agents
   reproduced that defect verbatim without it.

## The task

**Step 1 only: the provider registry, with Anthropic as the sole implementation.**

It is NOT a no-op refactor. That claim was in revision 1 and was wrong. It:

- absorbs `scoreFit` (`app/actions/parse-role.ts`) onto the interface — it calls
  `clientFor().messages.create` directly today and is the app's highest-volume
  model call, running per role inside `ingestRoles`' `Promise.all`;
- absorbs `saveApiKey`'s validation call (`app/actions/api-key.ts`), the other
  raw SDK use;
- adds `provider` and `model` to `BillingScope` (`lib/billing-context.ts`) and to
  `tenant_api_keys`, **bound into the AAD** in `lib/secret-box.ts` alongside
  `tenant_id` — otherwise the routing config can be swapped independently of the
  ciphertext it routes;
- replaces the module-level `export const MODEL` with per-tenant resolution.
  Three importers, one of them a test mock, and a `const` cannot become an async
  DB read.

Do not start OpenAI. Step 1 ships and verifies on its own.

## State of the world

Live at `https://jobs.tomkeefe.ai`, behind a shared-password gate
(`GATE_TOKEN` on the `web` service) AND Google sign-in. Both are active; the gate
is throwaway and gets deleted when it stops earning its place.

Shipped and verified today:

- **Backups** — `db/backup.mjs` to Cloudflare R2, guard tested, and a restore
  proven (`db/restore-verify.sh`). Take one before any migration; it is why the
  tenancy work was safe.
- **Auth** — Auth.js v5 beta, pinned EXACTLY. Identity is `(provider, sub)`,
  never email. Sessions have an absolute cap Auth.js does not provide.
- **Multi-tenancy** — `tenant_id` on all eight app tables, RLS with `FORCE`, a
  non-superuser `app_rw` role, and a GUC-readback assertion in `lib/supabase.ts`.
- **Metering** — reserve/cap/reconcile, proven under 40-way concurrency.
- **BYO keys** — AEAD-sealed, `key_id` for rotation, `tenant_id` as AAD.
- **No free tier** — tier is `admin | byo | none`. The platform key is reachable
  only on the admin branch.
- **Golden set** — `lib/__fixtures__/fit-golden-set.json` + `lib/fit-agreement.ts`.
  This is the ship gate for provider #2. Do not weaken it.

767 tests. `npm run build && npm test` is the gate. `npm run lint` is
non-functional — do not add it.

## Traps that cost time today

**Deploys.** `web` deploys from GitHub `main` on push, automatically. A Railway
VARIABLE change rebuilds from the connected repo — so keep `origin/main` current
or a variable edit reverts production. This silently held production 108 commits
behind for days.

**Verify against the DEPLOYED commit.** `railway deployment list --service web
--limit 1 --json` carries `meta.commitHash`. A `CRON_SECRET` rotation was
reported verified while the route it guarded did not exist in the running build.

**Polling a deploy.** Break only on a TERMINAL state, and make sure you are
polling the deployment created AFTER your change — polling too early reads the
previous deployment's SUCCESS and reports a change as live that has not built.

**`req.url` in a route handler is the BOUND address.** Railway terminates TLS at
its proxy, so redirects built from it point at `localhost:8080`. Use a relative
`Location`. Middleware is unaffected. Auth.js needed `AUTH_URL` set explicitly —
`trustHost` alone was not enough.

**`"use server"` forbids non-async exports.** A constant declared in an action
can be neither exported nor tested. Put it in `lib/`.

**The global `pg` type parser returns timestamps as ISO STRINGS.** Auth.js wants
`Date`s and hands `expires` to a cookie serializer, which rejects a string. A
separate pool does not help — `setTypeParser` is global to the module. The
adapter wrapper in `auth.ts` converts at the boundary.

**RLS failures are silent.** A denied read returns zero rows, not an error. That
is a plausible answer for a new tenant and is invisible to every detection
mechanism in this repo. The GUC-readback assertion in `lib/supabase.ts` is what
converts that class into loud errors — do not remove it.

**Test mocks.** Several suites mock `@/lib/metered`, `@/lib/tenant` and
`@/lib/require-actor` so they can exercise their own logic. If you change those
modules' shapes, the mocks go stale silently. `app/actions/auth-required.test.ts`
enumerates every exported action and asserts it refuses without a session — it
was negative-controlled by deleting one guard and confirming it failed.

## Settled — do not reopen

- **No free tier, no trial allowance.** Every tenant brings their own key. A
  reviewer argued for a bounded lifetime grant; the owner overruled it
  deliberately. It is recorded in the spec as overruled, not dropped.
- **No external search, no local models, no `openai-compatible`.** Cut in
  revision 2 for reasons the spec lists. The short version: a hosted container
  cannot reach a user's `localhost`, and a tenant-supplied base URL would carry
  their decrypted key to an arbitrary host from inside the private network.
- **Native provider search only.** Anthropic, then OpenAI, then Google when asked.
- **The waitlist stays.** Approval is about whose data lands in this database,
  not about rationing credits.

## Errors made today, so they are not repeated

Recorded because each cost real time and each came from asserting instead of
checking.

- **A "credential leak" that was not one.** `.env.production` in git history was
  declared a live leak from its FILENAME. Measured, its values are empty and its
  one real token belongs to the previous owner and expired in June. Measure
  values before calling something a leak.
- **A spec foundation claim made from a file listing.** "All eight AI calls go
  through two provider-neutral functions" — `scoreFit` does not, and the same
  session had edited it. Grep the call graph.
- **A measurement that graded the wrong stage.** A search comparison concluded
  4× cheaper; it was censored by the prompt's 20-row cap, pooled an outlier the
  document itself called non-repeating, and never priced the downstream stage
  where the money actually is. Three runs revealed the variance; they did not
  support a claim through it.
- **A planner with no date context** wrote queries for the wrong year and
  returned stale rows that still looked like results.

## Verification you can run

```bash
npm run build && npm test

# what is actually deployed
railway deployment list --service web --limit 1 --json

# the platform path, end to end (no writes, no spend)
S=$(railway variables --service crawler --kv | grep '^CRON_SECRET=' | cut -d= -f2)
curl -s -H "Authorization: Bearer $S" 'https://jobs.tomkeefe.ai/api/cron/crawl?dry=1'

# migrations (idempotent; db/apply-schema.mjs is fresh-install only)
railway run --service Postgres sh -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" node db/migrate.mjs --dry'

# take a backup before any migration
railway run --service backup sh -c 'PGHOST=reseau.proxy.rlwy.net PGPORT=47766 node db/backup.mjs'
```

The app password is in the owner's password manager; `GATE_TOKEN` on `web` is the
source of truth and changing it logs every device out.

## Open, and deliberately not decided

- Does OpenAI's search cap uses per request? If not, `searchCapEnforcement` is
  `"none"` and metered tiers cannot use search there. **Verify before writing the
  adapter**, not after.
- Do reasoning models blow the tuned `maxTokens`? The 8000 in `roles.ts` was set
  because search narration counts against output; reasoning tokens do too, and an
  exhausted budget returns empty text that `parseJson` throws on.
- Rate limits. `ingestRoles` fires up to 25 `scoreFit` calls in a `Promise.all`.
  The Anthropic SDK retries; a hand-rolled adapter will not.
