# Error-handling audit — silent-failure sweep

Worktree `chad-job-search-errors`, branch `worktree-errors`, from `main` at `8499a66`.
Audit only. No code changed.

Baseline confirmed: `npm run build` exit 0, `npm test` **531 tests / 26 files passed**.
`npm run lint` not run (non-functional in this repo by design).
No database, no Anthropic key, no browser — every reachability claim below comes from
reading code or from probing `pg` locally with no server. Anything needing a live
database is marked **SKIPPED**.

---

## 0. Reachability: what actually produces an empty error message

This is the load-bearing question for two thirds of the sweep, so it was settled first,
against `pg` itself rather than from the comments.

`lib/supabase.ts` builds every error in exactly two places (`execute()` line 207-212 and
`rawQuery` line 234-238), both the same shape:

```ts
error: { message: e instanceof Error ? e.message : String(e) }
```

There is one other producer: `single()` with zero rows returns `{ message: "No rows returned" }`
(line 199) — always non-empty.

Probed locally (no database involved, just the driver):

| connection string | ctor | `message` |
|---|---|---|
| `""` (DATABASE_URL unset) | `AggregateError` | `""` |
| `postgres://…@localhost:5432/db` (nothing listening) | `AggregateError` | `""` |
| `postgres://…@localhost:59999/db` | `AggregateError` | `""` |
| `postgres://…@no-such-host.invalid:5432/db` | `Error` | `"getaddrinfo ENOTFOUND …"` |
| `postgres://…@127.0.0.1:59999/db` | `Error` | `"connect ECONNREFUSED 127.0.0.1:59999"` |

**The mechanism is narrower and more specific than "unset DATABASE_URL".** The empty
message is Node's `AggregateError`, produced when a host resolves to **more than one
address** and **every** connection attempt fails. `AggregateError.message` is `""`; the
real messages are on `.errors[]`, which nothing in this repo reads. A single-address
host produces an ordinary `Error` with a real message.

Three consequences that shape the rankings:

1. **An empty message is always a connection-level failure, never a statement-level
   one.** A SQL error from a connected server (constraint violation, missing table,
   type mismatch) always carries text. So the empty-string class can only fire when
   the pool cannot reach Postgres at all.
2. **It is broader than "no DATABASE_URL".** Any dual-stack hostname — `localhost`,
   and plausibly Railway's `*.railway.internal` during a Postgres restart — hits it
   whenever every address refuses. **SKIPPED:** whether Railway's internal DNS returns
   multiple addresses cannot be verified without the live network. The `DATABASE_URL`-unset
   case is confirmed either way.
3. **Connection-level means process-wide and simultaneous.** Every query in flight fails
   together. So "swallowed write followed by a successful read" needs the outage to
   *start or end* inside the window between the two calls. This narrows several sites
   materially, and is called out per-site below rather than assumed away.

The repo's own cure — `describeWriteFailure` (`app/actions/settings.ts` consumers,
defined `lib/settings-store.ts:266`) and `UNDESCRIBED_DB_ERROR` (`lib/settings-store.ts:246`)
— is the correct target shape and is assumed throughout.

---

## 1. Inventory

**42 sites examined across `app/`, `lib/`, `components/`, `db/`.**
**13 judged defects worth considering** (Tier A + Tier B), **17 correct-as-written or
cosmetic** (Tier C), **12 deliberate soft-fails or non-defects** (Tier D).

Files swept: all of `app/actions/*`, `app/api/cron/crawl/route.ts`, all `app/*/page.tsx`,
all of `lib/*.ts` (non-test), all of `components/*.tsx`, `db/apply-schema.mjs`,
`db/schema.sql`.

---

## Tier A — worth fixing, ranked most consequential first

### A1. `components/RolesTable.tsx:159-172` — three optimistic writes discard their result entirely

```ts
async function handleStatus(job, status) {
  setJobs(prev => prev.map(...));      // UI updated first
  await updateJob(job.id, { status }); // result thrown away
}
async function handleDelete(id)        { setJobs(...); await deleteJob(id); }
async function handleFieldSave(id, f, v) { setJobs(...); await updateJob(id, {[f]: v}); }
```

- **What the user experiences:** they drag a role to *Applied* or *Offer*, or type into
  an inline field, the UI shows the new value, and the database never received it.
  No banner, no console line, no revert. The lie persists until a reload, by which time
  the user has moved on and has no reason to re-check.
- **Reachable?** Yes, and this is the only Tier A entry **not** gated on an empty message.
  The result is discarded unconditionally, so *any* failure is silent — connection blip,
  constraint violation, a bad `field`/value pair through the untyped
  `{ [field]: value } as Partial<Job>` cast. This is the single most reachable defect in
  the sweep.
- **Downstream amplification:** `handleStatus` is the pipeline-stage control. `crawler.ts`'s
  `STALE_POSTING_CANDIDATES_SQL` comment reasons at length that "a lost pipeline stage
  costs unrecoverable information" and refuses to let the crawler touch a non-`New` row —
  and then the UI loses that same stage for free. `handleFieldSave` edits are hand-typed
  and unrecoverable. `handleDelete` is the mildest: the row returns on reload.
- **Severity: data loss + actively misleading UI.** Highest in the sweep.
- **Fix shape:** these three need more than a log line — either surface the error and
  revert the optimistic state, or re-`load()` on failure. Not a `describeWriteFailure`
  drop-in.

### A2. `app/actions/roles.ts:89`, `app/actions/discover.ts:110`, `app/actions/insights.ts:63-64` — billed Claude results cached with the write result discarded

```ts
await supabase.from("discovered_roles").upsert({...});      // roles.ts:89
await supabase.from("discovered_startups").upsert({...});   // discover.ts:110
await supabase.from("insights_cache").delete().neq(...);    // insights.ts:63
await supabase.from("insights_cache").insert({...});        // insights.ts:64
```

- **What the user experiences:** nothing at all, which is the problem. The search
  returns results and renders them; the cache write fails; the next click re-runs the
  full billed query set. Forever, with nothing connecting the two.
- **Reachable?** Yes, unconditionally — the error object is never bound, so message
  content is irrelevant. The most likely trigger is not an outage at all: a deploy
  without `DATABASE_URL=… node db/apply-schema.mjs`, where the table simply does not
  exist. That is a statement-level error with a perfectly good message that nobody reads.
- **Downstream amplification:** money. `findAndSaveRoles` (`roles.ts`) is one of the
  **uncapped** web-search callers — it omits `maxSearches` entirely, so `max_uses` is
  `MAX_QUERY_MULTIPLIER ×` the query count. Every repeat click re-bills that.
  `roles.ts:41` compounds it: the cache **read** also discards its error
  (`const { data } = await supabase…`), so a read failure falls straight through to the
  billed path with no log.
- **Precedent:** the repo already fixed exactly this, in `app/actions/role-search.ts:169-194`,
  with a comment calling a discarded error there *"the most expensive silence in this
  file"* and a user-facing message that names `db/apply-schema.mjs` by path. These three
  are the same silence in the three siblings that were not swept. **The pattern to copy
  already exists in the codebase.**
- **Severity: wastes money, invisibly, at an unbounded rate.**

### A3. `app/actions/settings.ts:161, 176, 192, 251` — `if (error)` truthiness on `writeSetting`/`deleteSetting`

```ts
const { error } = await writeSetting(key, result.value);
if (error) return { error: `Could not save ${label} — ${error}` };
await applySideEffects(key);   // runs anyway on an empty-message failure
return {};                     // reported to the UI as success
```

- **What the user experiences:** `components/Settings.tsx:293`'s `run()` shows **"Saved."**
  and then calls `refresh(section)`, whose `syncSection` **replaces the user's typed draft**
  with whatever came back from the re-read. For `fitBrain` that means a long, carefully
  written prompt is wiped from the textarea and was never stored. `getSettings`'s own
  doc comment states the stakes: *"there is no history table"*.
- **Reachable?** Yes for the empty case (§0), but with a real mitigation worth stating
  honestly: during the same outage `refresh()`'s read also fails, and *that* path
  **is** presence-based (`buildSettingsView`, `lib/settings-view.ts:87`), so the
  `settingsReadWarning` banner does appear. The user sees a contradictory page —
  "Saved." next to "these are the shipped defaults, do not save from this page" —
  rather than a wholly silent one. The unrecoverable part is the discarded draft, not
  the missing banner.
- **Downstream amplification, and this is the part the mitigation does *not* cover:**
  the swallowed failure falls through to `applySideEffects(key)`, which then
  (a) **deletes the `discovered_roles` / `role_searches` caches** for a save that never
  landed — forcing a full re-billed search on the next Discover/Role-Search click
  (compounding A2), and (b) **stamps `criteria_changed_at`** for crawl-relevant keys,
  which `runsEligibleForClosure` uses to discard closure evidence — suppressing
  stale-posting closure for ~2 crawl cycles per tracked company, on the strength of an
  edit that was never persisted. `resetSetting` (line 251) does the same on the reset path.
- **Severity: loses hand-written text, wastes money, and briefly corrupts crawler behavior.**
- **Fix shape:** the established cure verbatim — these four are the untreated siblings of
  `saveCompFloor` (line 238), which already does it right. Four one-line changes.

### A4. `app/actions/watchlist.ts:52` — `resolveExistingCompany` discards its read error

```ts
const { data } = await rawQuery<ExistingCompanyRow>(`select company, careers_url from watchlist`);
const match = findExistingCompany(data ?? [], trimmed);
```

- **What the data experiences:** a failed read is indistinguishable from an empty
  watchlist, so `found: false` and `careers_url: null`. Two callers act on that:
  - **`addToWatchlist`** then calls `resolveCareersUrlWrite(null, startup.careers_url)`,
    which — believing nothing is stored — returns Discover's **guess**. The upsert
    **overwrites a hand-typed careers URL with a model guess** and, because a defined
    return is also the reset signal, nulls `crawl_method`, `last_crawl_status`,
    `last_crawl_error`. `lib/careers-url-precedence.ts` exists specifically to prevent
    this: *"It may have been typed by hand on the Watchlist page to recover a company
    whose crawl was broken — Discover's guess must never clobber it."*
  - **`trackCompanyByName`** falls back to the input's casing, defeating the
    case-collision guard its own comment describes: a second `watchlist` row under a
    different casing, billed separately, with `ingestRoles` re-inserting every role as new.
- **Reachable?** Narrowly. Both callers need read-fails-then-write-succeeds, and since
  an empty message means a *connection-level* outage (§0), the upsert two lines later
  would normally fail too. It needs a blip that ends inside that window. **But note this
  site is not gated on message emptiness at all** — any read failure with any message
  triggers it, including a statement-level one, which widens it beyond the outage case.
- **Downstream amplification:** the bad state is **persisted and permanent**. Nothing
  re-derives the clobbered careers URL; the duplicate row must be deleted by hand.
- **Severity: permanent bad data, low probability.** Ranked here for the permanence, not
  the odds.
- **Fix shape:** a discard, not a mis-test — needs a different cure (propagate the error
  and refuse the write, the way `resolveWriteTarget` already refuses on `!found`).

### A5. `getWatchedCompanyKeys` — `app/actions/watchlist.ts:170` discards its query error

```ts
const { data } = await supabase.from("watchlist").select("company").eq("tracking_enabled", true);
return new Set((data ?? []).map(r => normalizeCompanyName(r.company)));
```

- **What the user experiences:** an empty `Set` is *"nothing is watched"*, which is a
  perfectly plausible answer and therefore indistinguishable from the failure.
  Discover renders every company un-starred with a live Track button;
  `untrackedFrom` (`role-search.ts:86`) lists every result company as untracked.
- **Reachable?** Yes, any read failure, message irrelevant.
- **Downstream amplification:** clicking the falsely-offered Track button calls
  `trackCompanyByName`, which routes through **A4** — so during the same failure window
  this site *manufactures the clicks* that trigger A4's duplicate-row path. That
  coupling is the reason it is ranked above the remaining entries rather than with the
  log-only tier.
- **Severity: misleads the user; feeds a write path that can corrupt.** Called out in
  the brief as a different defect, and it is: the error is discarded, not mis-tested.
- **Fix shape:** return `{ keys, error }` (or throw). `describeWriteFailure` does not
  apply — there is no `{ error?: string }` to describe.

### A6. `lib/role-search-cache.ts:41` — `shouldReplaceRoleView` inverts its own contract on an empty error

```ts
export function shouldReplaceRoleView(res: RoleSearchResultLike): boolean {
  return !res.error || res.fetchedAt !== null;
}
```

- **What the user experiences:** with `error: ""` and `fetchedAt: null` — exactly what
  `getCachedRoleSearch` returns on a failed read — `!res.error` is `true`, so the panel
  **wipes the roles it is displaying**. The function's own doc comment says the
  opposite: *"applying that wipes results the database still holds, and the only way
  back is toggling the family and back, which nothing tells the user."*
- **Reachable?** Only via the empty-message path (§0); a described error works correctly.
- **Downstream amplification:** none — recoverable by toggling family, once the user
  guesses that.
- **Severity: low blast radius, but it is the one place where the fix is provably free.**
  This is a pure function with an existing test file (`lib/role-search-cache.test.ts`),
  so `res.error !== undefined` is a one-token change that can be pinned by a test —
  unlike most of this sweep. Included for cost, not for consequence.

---

## Tier B — real but marginal; fix only if a neighbouring change makes it free

### B1. `lib/ingest-roles.ts:142` — `if (jobRes.error)` counts a failed insert as added

```ts
if (jobRes.error) { console.error(...); return; }
added.push(role);
```

An empty message skips the `return`, so `added` gains a role that was never inserted.
That count flows to `CrawlOutcome.newRoles` → `crawl_runs.new_roles` → the cron summary
log → the Watchlist "N new" notice.

**But the empty case here is close to unreachable, and this matters for the fix decision.**
`ingestRoles` opens (line 77-87) by *throwing* on its own read error. An empty message
means a connection outage; an outage present at entry aborts the function before line 142
is ever reached. To hit this you need the outage to *begin* in the window between the
read and the insert — after `checkJobUrl`'s network round trips. `scoreFit` is skipped
regardless (`jobRes.job` is `undefined` when `addJob` errors), and the missing role
self-heals on the next crawl. Net damage in the reachable case: **one wrong number and
one lost log line.** Named in the brief's starting list; my judgment is that it is the
weakest entry on it.

### B2. `lib/ingest-roles.ts:165`, `components/RolesTable.tsx:628`, `components/RecruiterPanel.tsx:128` — `await updateJob(...)` result discarded

The fit score silently fails to land; the role renders unscored. Self-correctable via a
rescore pass. Worth noting only because `rescoreAll` checks this exact call with a
34-line comment (`app/actions/settings.ts:427-443`) explaining that *"lib/crawler.ts
fixed exactly this 'counted a failed write as a success' bug already"* — and three other
call sites of the same function still discard it. Cheap: a `console.error`.

### B3. `components/RolesTable.tsx:625` and `components/RecruiterPanel.tsx:123` — `if (jobRes.error)` on a hand-typed role

An empty message falls through, `jobRes.job` is `undefined` so the score patch is
skipped, and `onAdded()` closes the drawer as though the role saved. The hand-typed role
is gone.

Reachability is outage-only, and in that same outage `RolesTable.tsx:64`'s `getJobs`
also returns `{ jobs: [], error: "" }` → `setError(null)` → **the table renders as empty
with no banner**. So the page is visibly odd rather than convincingly normal, and a
reload reveals the truth. Named in the brief's starting list. Real, but bounded.

**Fix-shape note (this is the leverage point for B1+B3):** all of `app/actions/jobs.ts`'s
five functions return `error.message` verbatim. Normalizing at that source —
`error.message || UNDESCRIBED_DB_ERROR` in `jobs.ts` — makes **every** caller's
truthiness test correct at once (`ingest-roles:142`, `RolesTable:64` and `:625`,
`RecruiterPanel:123`, plus the already-fixed check in `rescoreAll`), for one change
instead of five. See §4 for why that is in tension with the stated doctrine.

### B4. `app/actions/settings.ts:107, 111` — `countCrawlJobsMatchingTitles` omits `UNDESCRIBED_DB_ERROR`

Its sibling `countScoredJobs`, twenty lines above, substitutes the stand-in and explains
why in a six-line comment. This one interpolates `error.message` raw into both the log
and the user-facing string, yielding `"Could not count matching roles — "`. Because of
the prefix the string is still non-empty, so the failure is still *reported* — the
sentence just trails off. **Cosmetic only.** Listed because it is a one-line consistency
fix inside a function that will already be open if A3 is taken.

---

## Tier C — examined and judged NOT worth fixing

Every item here was traced to its consequence. I would not spend a diff on any of them.

1. **All `if (error)` tests on `{ message: string } | null` objects.** `lib/supabase.ts`
   returns an object or `null`, never an empty object, so truthiness **is** presence and
   these are correct as written. Only the interpolated `${error.message}` can be blank,
   which loses log text, never a branch. This covers the largest single group in the
   sweep: `crawler.ts:525, 564, 599, 703, 721` and `:495`; `jobs.ts:12, 28, 48, 66, 75`;
   `watchlist.ts:91, 185, 222, 294`; `discover.ts:42, 79`; `roles.ts:29`;
   `insights.ts:22, 38`; `role-search.ts:94, 186`; `settings.ts:66, 106, 130, 385, 474`;
   `settings-store.ts:283, 338`; `ingest-roles.ts:85`. **~30 sites. Changing them would
   be exactly the bad trade the brief warns against.**
2. **`lib/crawler.ts:399` (`lastSuccessfulTitles`) and `:470` (`closeStalePostings`)** —
   both discard a read error. Traced: a failed read yields `[]`, which drives
   `titlesToClose` under its two-run minimum (or an empty candidate list), so **nothing
   is closed**. That is the safe direction and matches the file's stated safety property
   (*"a fetch failure must not close a live job"*). Costs a log line, changes no
   behavior. At most add a comment saying the soft-fail is intentional — it currently
   reads as an oversight.
3. **`app/actions/watchlist.ts:140, 150, 246, 265** (`if (target.error)`)** — `resolveWriteTarget`
   only ever produces the non-empty template `"X" is not on the watchlist.`, so truthiness
   is safe. Correct as written.
4. **`components/Settings.tsx:293** (`run()`'s `if (res.error)`)** — becomes safe for free
   once A3 lands, since every action it wraps would then return a `describeWriteFailure`
   string. Do not touch the component.
5. **`components/Settings.tsx:456** (`if (stamp.error)`)** — `markCompScoringRescored`
   already uses `describeWriteFailure`; its error is non-empty when present. Correct.
6. **`components/Watchlist.tsx:54, 56` and `lib/track-outcome.ts:22`** — `outcome.error ?? "…"`
   lets an empty string through, rendering `"Company: "` or `"needs attention:  (set a
   careers URL…)"`. Requires a `crawlCompany` catch to have caught an `AggregateError`.
   Purely cosmetic.
7. **`components/Discover.tsx:142, 150`; `components/Insights.tsx:18, 29`;
   `components/RoleSearchPanel.tsx:57, 92`; `components/Watchlist.tsx:48, 70, 95, 112`;
   `components/RolesTable.tsx:586`; `components/RecruiterPanel.tsx:58`** — client-side
   truthiness tests on strings whose producers are Claude-path templates or
   already-normalized. An outage-only miss costs a banner, and every one of these pages
   reloads from scratch. Fix at the server-action source if at all; do not sweep the
   components.
8. **`app/api/cron/crawl/route.ts:59`** — `if (error)` on `getDueCompanies`'s string.
   An empty message skips the 500 and proceeds with `due = []`, so the batch crawls
   nothing and logs `crawled=0`. Fails toward *not* spending money and leaves a log line
   either way. The next tick retries. Genuinely harmless.

---

## Tier D — deliberate soft-fails and non-defects. Do not "fix" these.

1. **`readAllSettings` (`lib/settings-store.ts:287`)** — presence-based, logs loudly with
   `UNDESCRIBED_DB_ERROR`, returns `[]` so the crawler degrades to shipped defaults
   rather than reporting "no roles" for every company. **Documented, correct, and the
   reference implementation.** Fails soft *and says so*.
2. **`readCriteriaChangedAt` (`:333`)** — same pattern, returns `null` so a failed
   decorative read cannot abort a crawl run. Logs with the stand-in. Correct.
3. **`readAllSettingsResult` (`:274`)** passing `error.message` through **verbatim,
   empty string included**, is deliberate and documented: *"a transport layer that
   invents text makes the presence check untestable, and the presence check is the half
   that actually matters."* Do not normalize here.
4. **`readCompFloor` via `app/roles/page.tsx`** — soft-fails to `null` through
   `readAllSettings` (already logged there), so the compensation filter is absent rather
   than wrong. Intentional; `force-dynamic` on that page exists for the related reason.
5. **`remainingCountFrom` (`lib/rescore-scope.ts:112`)**, **`passDrained`
   (`lib/rescore-progress.ts:297`)**, **`runRescorePass`'s `res.error !== undefined`
   (`:417`)**, **`buildSettingsView` (`lib/settings-view.ts:87`)**, **`saveCompFloor`
   (`app/actions/settings.ts:238`)**, **`markCompScoringRescored` (`:312`)**,
   **`rescoreAll`'s `updateJob` check (`:439`)** — the seven sites already converted to
   the presence/description doctrine. All correct.
6. **`app/actions/insights.ts:63` `.neq("id", "00000000-…")`** — checked specifically
   for the `<> NULL` bug. It is not one: `insights_cache.id` is `uuid primary key
   default gen_random_uuid()` (`db/schema.sql:83`), never null, so `id <> '000…'`
   matches every real row. The sentinel-UUID idiom is brittle but works. **The `<> NULL`
   defect has been fully eliminated from this repo** — the only remaining `.neq(` call is
   this one, and the other two matches are comments warning against the pattern.
7. **`db/apply-schema.mjs`** — catches, prints `e.message`, and `process.exit(1)`. Exits
   non-zero regardless of message content. Correct.
8. **`lib/verify-url.ts:19, 40` and `lib/crawler.ts:198`** — bare `catch` returning
   `"unknown"` / `null`. Deliberately conservative: *"only a definitive 404/410 counts
   as dead"*. Correct.
9. **`lib/anthropic.ts:86`** — `catch` around the issued-searches logging, explicitly
   *"Never let this break the call."* Correct.

---

## 2. Ranked fix list

| # | Site | One-line blast radius |
|---|---|---|
| 1 | `components/RolesTable.tsx:159-172` | Status changes, inline edits and deletes report success in the UI while the write is discarded — hand-typed data and pipeline stages lost, on *any* failure, not just an empty one. |
| 2 | `app/actions/roles.ts:89` + `:41`, `discover.ts:110`, `insights.ts:63-64` | Cache writes after a billed (and for `roles.ts`, uncapped) Claude search are discarded, so a missing table or a blip re-bills every subsequent click forever with zero log output. |
| 3 | `app/actions/settings.ts:161, 176, 192, 251` | An empty-message write failure reports "Saved.", discards the user's typed fit brain via `syncSection`, *and* still runs `applySideEffects` — clearing paid-for caches and stamping `criteria_changed_at` for an edit that never landed. |
| 4 | `app/actions/watchlist.ts:52` (`resolveExistingCompany`) | A discarded read error makes a hand-typed careers URL look absent, so Discover's guess overwrites it and resets the crawler's learned state — permanent, manual to undo. |
| 5 | `app/actions/watchlist.ts:170` (`getWatchedCompanyKeys`) | A discarded read error reads as "nothing is watched", un-stars every company, and manufactures the Track clicks that feed #4. |
| 6 | `lib/role-search-cache.ts:41` | An empty error wipes the displayed role list, doing precisely what the function's own doc comment says it exists to prevent — one-token fix in a pure, already-tested function. |
| 7 | `lib/ingest-roles.ts:165`, `RolesTable.tsx:628`, `RecruiterPanel.tsx:128` (B2) | A discarded `updateJob` means the fit score silently never lands; role renders unscored, self-heals on rescore. Log line only. |
| 8 | `RolesTable.tsx:625`, `RecruiterPanel.tsx:123` (B3) | A hand-typed role is lost on an outage-only empty error; the same outage already renders the table empty, so it is visible, just not explained. |
| 9 | `lib/ingest-roles.ts:142` (B1) | Inflates `newRoles` by one and drops a log line, in a window that is nearly unreachable because the same function throws on its own read error 60 lines earlier. |
| 10 | `app/actions/settings.ts:107, 111` (B4) | The message trails off after a dash. Cosmetic; take it only because A3 opens the file. |

**Cut line: take 1-6. Items 7-10 only if a neighbouring diff makes them free.**

Items 1-3 are where nearly all the damage is, and they are three separate cures, not one
sweep. Items 4-5 are one coupled pair in one file. Item 6 costs a token.

### Not worth fixing, and why

- **The ~30 `if (error)` tests on error *objects*** (Tier C.1). Truthiness equals presence
  when the value is `{message} | null`. Converting them to `!== null` changes no
  behavior and is the 30-call-sites-to-close-3-bugs trade to avoid.
- **`crawler.ts:399` and `:470`** (Tier C.2). Both fail toward closing nothing, which is
  the direction the file's safety argument demands. A comment, not a change.
- **Every client-component truthiness test** (Tier C.7). Their producers are the right
  place to fix; the components would then be correct for free.
- **`cron/crawl/route.ts:59`** (Tier C.8). Fails toward not spending money; the next
  tick retries.
- **All of Tier D.** These are documented, deliberate soft-fails that *say so in the log*,
  or sites already converted to the doctrine. Reporting them would be reporting the cure
  as the disease.

---

## 3. Where the standard cure does not fit

`describeWriteFailure` suits exactly one shape: a function that already returns
`{ error?: string }` from a write, tested at a call site. Four of the ten ranked items
are not that shape.

1. **`RolesTable.tsx:159-172` (#1) — nothing to describe, and describing it is not the
   fix.** These calls discard the result rather than mis-test it, and the UI has *already
   applied the change optimistically*. A message alone leaves the screen lying. The fix
   is a decision, not a substitution: revert the optimistic state on failure, or re-`load()`.
   That is a behavior change and deserves its own review.

2. **`resolveExistingCompany` (#4) and `getWatchedCompanyKeys` (#5) — no error channel
   exists.** Both return a bare value (`ResolvedCompany`, `Set<string>`) with the error
   dropped at the `const { data } =` destructure. There is nothing for
   `describeWriteFailure` to take. Each needs a signature change — `{ keys, error }`, or
   a throw — plus a decision at every caller about what to do with it. Note the two are
   coupled: #5's empty Set generates the Track clicks that trigger #4's clobber path, so
   fixing one without the other leaves the pair half-closed. **Also note they are *read*
   paths, where this repo's deliberate house style is to fail soft** (Tier D) — so the
   right answer may be "fail soft *and log*, like `readAllSettings`" rather than
   "propagate". That is a judgment call for the fix task, and the difference matters:
   `readAllSettings` fails soft to a value that is *safe* (shipped defaults), whereas
   these two fail soft to values that are actively *wrong* (`careers_url: null` licenses
   a clobber; an empty Set licenses a duplicate row). Same shape, opposite consequence.

3. **Tier A2's cache writes (#2) — the cure exists but is not `describeWriteFailure`.**
   The established pattern here is `role-search.ts:169-194`: bind the error, log it,
   and return a *user-facing* string that names `db/apply-schema.mjs` — because the
   dominant cause is a missing table, not an outage, and the user can act on that.
   Copy that, not the settings cure.

4. **The `jobs.ts` normalization question (B3's fix-shape note) is a genuine doctrine
   conflict and should be decided deliberately, not by whoever writes the patch.**
   Normalizing `error.message || UNDESCRIBED_DB_ERROR` inside `app/actions/jobs.ts`
   would fix five call sites with one change. But `lib/settings-store.ts:241-245` states
   the opposite rule for its own transport layer: *"readAllSettingsResult keeps the
   driver's message verbatim — including the empty one — because a transport layer that
   invents text makes the presence check untestable, and the presence check is the half
   that actually matters."* `jobs.ts` is the same kind of layer. Following the doctrine
   costs five call-site edits; breaking it costs one edit and a documented inconsistency.
   Worth an explicit ruling either way.

5. **`settings.ts:107/111` (#10)** is the one clean `UNDESCRIBED_DB_ERROR` drop-in in the
   whole list, and it is cosmetic.

---

# Fixes

Items 1-6 implemented, plus item 10. Five commits off `8499a66`, one per
independent fix so a reviewer can reject any one without rejecting the rest.

| # | commit | item |
|---|---|---|
| 1 | `53a98f9` | #1 — RolesTable's three optimistic writes (+ the `write-failure` extraction and the transport diagnostic) |
| 2 | `ef46cc0` | #2 — billed Claude results that could not be cached |
| 3 | `8d84e95` | #3 — the four remaining settings writes (+ item #10) |
| 4 | `b94415b` | #4 and #5 — the coupled watchlist pair |
| 5 | `ff84e7b` | #6 — `shouldReplaceRoleView` |

**Gate: `npm run build` compiled successfully, `npm test` 568 tests / 28 files
passed.** Floor was 531 / 26; +37 tests, +2 files, none removed or skipped.
`npm run lint` never run.

## Rulings, as applied

**Ruling 1 (no normalization in `app/actions/jobs.ts`) — followed.** All five
of its functions still return `error.message` verbatim, and each caller detects
presence itself. The one structural consequence: `describeWriteFailure` and
`UNDESCRIBED_DB_ERROR` had to become reachable from a client component, because
they lived in `lib/settings-store.ts`, which imports `pg` through
`lib/supabase.ts`. They moved to a new **import-free `lib/write-failure.ts`**
and `settings-store` re-exports them, so no existing importer changed. This is
the doctrine intact, not bent — the transport still invents nothing, and the
move is what killed the reason `lib/rescore-progress.ts` had to hand-copy a
twin.

**Ruling 2 (re-`load()`, do not revert) — followed**, with the failure surfaced
as instructed. One ordering subtlety worth flagging: `setError` must run
**after** `await load()`, because `load()` clears the banner on a clean read and
would otherwise wipe the very message that explains the reload.

**Ruling 3 (copy `role-search.ts`, name `db/apply-schema.mjs`) — followed.**
The message moved into `lib/cache-write-warning.ts` and `role-search.ts` now
uses it too, so all four paths say the same thing and the schema command exists
in one place rather than four.

## The `AggregateError` finding, carried into the work

Two places, deliberately not everywhere.

**Copy.** `UNDESCRIBED_DB_ERROR` now says the database is *"unreachable
entirely rather than one operation having failed"*. That is not a stylistic
edit: an empty message is only ever produced by a connection-level failure, so
the old wording sent a reader looking for one bad write when every query in the
process was failing together. Pinned by a test, because a future copy edit that
softens it back reintroduces the misdirection silently.

**Diagnostic.** `aggregateCauses` + one log line in `lib/supabase.ts`'s two
catch blocks. This is the only place in the process where the real cause still
exists — `AggregateError.message` is `""` but `.errors[]` holds
`"connect ECONNREFUSED ::1:5432"` and its siblings, and every layer above sees
only the empty string.

It feeds a **log line and nothing else**, and that restraint is the point.
Filling in `message` from `.errors[]` would (a) make the transport invent text,
which the doctrine forbids, and (b) erase the empty-message case that roughly
a dozen presence checks in this codebase are written to survive — turning all
of them into untestable dead code. Behavior is byte-identical; only the log
gains anything.

## Mutation results

Every fix mutated, a **specific named test** watched to fail, then reverted and
watched to pass. Runtime kills and compile-time rejections reported separately,
as asked.

### Runtime kills

| mutation | test that failed |
|---|---|
| `error === undefined` → `!error` in `describeWriteFailure` | `describeWriteFailure > an EMPTY message is still a failure — presence, not truthiness` |
| drop the empty-cause filter in `aggregateCauses` | `aggregateCauses > a cause with an empty message of its own is dropped, not carried through` |
| drop the `Array.isArray` guard in `aggregateCauses` | `aggregateCauses > an ordinary Error has no hidden causes` |
| drop `node db/apply-schema.mjs` from the warning | `cacheWriteWarning > names the schema command …` + `… names the table in BOTH the failure and the fix` |
| drop `\|\| UNDESCRIBED_DB_ERROR` from the warning | `cacheWriteWarning > an EMPTY driver message gets the stand-in, not a dangling dash` |
| pluralize unconditionally in `countPhrase` | `countPhrase > pluralizes everything except exactly one` |
| name the table once instead of twice | `cacheWriteWarning > names the table in BOTH the failure and the fix` |
| lead with the failure instead of the result | `cacheWriteWarning > the produced clause leads …` |
| weaken the cost clause ("re-billed" → "repeated") | `cacheWriteWarning > says the cost of ignoring it` |
| `saveCriteriaList` back to truthiness | `… > saveCriteriaList: a write with NO message is a failure, not a save` + `… does NOT run the side effects` |
| `saveCriteriaText` back to truthiness | `… > saveCriteriaText: an empty-message failure does not report success` |
| `saveCeiling` back to truthiness | `… > saveCeiling: … on the write path` + `… on the DELETE path` |
| `resetSetting` back to truthiness | `… > resetSetting: an empty-message delete failure is reported` + `… does NOT run the side effects` |
| move `applySideEffects` above the guard | `… > resetSetting: a failed delete does NOT run the side effects` |
| unknown careers URL treated as "nothing stored" (the original bug) | `… UNKNOWN > a guess NEVER wins against an unknown stored value` (+2 more) |
| unknown short-circuits every case | `resolveCareersUrlWrite > existing null yields to a non-empty guess` (+4 more) |
| `untrackedFromWatched` presence → truthiness | `untrackedFromWatched > an EMPTY error message is still a failed lookup` |
| failed lookup answers "everything is untracked" | `untrackedFromWatched > a failed lookup offers NOTHING to track, rather than everything` |
| `shouldReplaceRoleView` back to truthiness | `shouldReplaceRoleView > an EMPTY error message with no payload ALSO leaves the view intact` |
| drop `shouldReplaceRoleView`'s payload escape hatch | `shouldReplaceRoleView > an error that still carries results replaces the view` (+1) |

One mutation attempt (`M1` on `cache-write-warning`, first pass) broke the file
rather than mutating it — vitest collected zero tests, which is **not** a kill.
Re-run correctly; the row above is the valid result.

The `cacheWriteWarning` "says the cost of ignoring it" test **failed on first
write against my own implementation** — the message never actually contained
the word it promised. The message was fixed, not the test.

### Compile-time rejections

Two, both from making an unsafe state unrepresentable rather than merely
discouraged. Neither could have been a runtime kill, because neither call site
would have compiled to run:

1. `resolveCareersUrlWrite`'s `StoredCareersUrl` union rejects the old bare
   `string | null` argument. The whole bug was that `null` meant both "nothing
   stored" and "could not look"; passing a string now cannot type-check.
2. `getWatchedCompanyKeys` returning `{ keys, error }` rejected **both** its
   callers (`app/actions/role-search.ts:88`, `components/Discover.tsx:84` and
   `:86`). The compiler found them, not a grep — which is the argument for
   changing the return type rather than adding an optional out-parameter.

### Not testable, stated plainly

`vitest` runs `environment: "node"` with no jsdom and no RTL, so **no React
component in this repo is testable**, and I did not manufacture a test for one.
That covers `components/RolesTable.tsx` (item #1's three handlers, `commitWrite`
and `load`), `components/Discover.tsx` (the `cacheWarning` branch and the
watched-keys banner). What *is* pinned is every pure decision those components
call into — which is why item #1's cure was extracted into `lib/write-failure.ts`
rather than inlined: the logic is now tested even though the component is not.

Also untested and unavoidably so: `lib/supabase.ts`'s two catch blocks
(`describeThrown`) need a live pool to reach. `aggregateCauses`, the part that
holds the actual reasoning, is tested against a hand-built `AggregateError`
matching the shape a real `pg` probe produced.

**SKIPPED** — everything requiring a live database, an Anthropic key, a
browser, or a deploy: no query was executed against Postgres, no Claude call
was made, no page was rendered, nothing was deployed. Reachability claims here
rest on reading code plus the local driver probe in §0, which needs no server.

## Items 7-10

**Took #10 only** (folded into commit 3): `countCrawlJobsMatchingTitles` now
substitutes `UNDESCRIBED_DB_ERROR` the way its sibling twenty lines above does.
Genuinely free — same file, same edit, and the module is untestable either way,
so it added no test. Cosmetic: the failure was already reported, the sentence
just trailed off after the dash.

**Left #7, #8, #9.** Reasoning, since the cut is the point:

- **#7** (`updateJob` result discarded at `ingest-roles.ts:165`,
  `RolesTable.tsx:628`, `RecruiterPanel.tsx:128`) — three files, only one of
  which this work otherwise opened, and even there a different function. Not a
  neighbouring edit.
- **#8** (`addJob` presence check at `RolesTable.tsx:625` and
  `RecruiterPanel.tsx:123`) — the closest call. `RolesTable.tsx:625` sits in a
  file already open and would reuse the helper already imported, so it is free;
  `RecruiterPanel.tsx:123` is byte-identical and is not. Fixing one and leaving
  its twin is exactly the drift this codebase keeps writing comments to warn
  about, so both are deferred as a pair. They are ~2 lines and want one commit.
- **#9** (`ingest-roles.ts:142`) — the audit judged the empty case
  near-unreachable (the same function throws on its own read error 60 lines
  earlier), and nothing in the implementation changed that. Net damage in the
  reachable case is one inflated count and one lost log line.

## Still open

1. **#7, #8 and #9 above** — a single small follow-up commit, if wanted. #8 is
   the only one with real (outage-only) user cost.
2. **`lib/rescore-progress.ts`'s `UNDESCRIBED_RESCORE_ERROR`** is now a twin
   with no reason to exist: it was hand-copied *because* the original could not
   be imported into a client bundle, and `lib/write-failure.ts` fixes exactly
   that. Deliberately left alone — its wording is rescore-specific UX copy, and
   collapsing it is a judgment call about voice, not a correctness fix.
3. **`components/Discover.tsx`'s suppressed `router.push`** on a cache-write
   warning is a deliberate UX change, argued in the commit message (an unread
   bill is not recoverable; the roles are one nav click away). It deserves an
   explicit yes/no rather than passing as an implementation detail.
4. **Nothing verified against a running system.** Every claim here is static.
   The changed paths that would most repay a live check, in order: a settings
   save against an unreachable database (item #3), a Discover "Find roles"
   click with `discovered_roles` dropped (item #2), and the new
   `supabase: the driver failed with no message` log line actually appearing
   with its causes attached.
