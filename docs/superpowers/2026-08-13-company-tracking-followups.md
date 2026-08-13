# Company Tracking — Open Follow-Ups

Carried out of the nine-task build (merged `bcab13b`, live-verified 2026-08-13).
These are the findings reviews raised that were deliberately NOT fixed, with the
reasoning. Nothing here is blocking; the feature is deployed and working.

## Ranked by what would actually bite

### 1. The shell heuristic is unvalidated against real pages

`lib/page-extract.ts` — a careers page counts as having real content only if it has
**3+ links** matching `JOB_LINK_PATTERN`, and that pattern misses Lever
(`jobs.lever.co/<co>/<uuid>`) and Ashby (`jobs.ashbyhq.com/<co>/<uuid>`) URL shapes.

Two failure directions, both silent:
- A genuine server-rendered page with 1-2 open roles is misjudged a "shell" and pinned
  to the expensive search tier.
- A real ATS shell with 3+ blog links matching `/job` (e.g. `/blog/job-market-trends`)
  is judged to have content, extraction returns nothing, and it reports "no roles"
  every week forever.

Both constants are pinned by tests at their current values (`MIN_JOB_LINKS = 3`,
`MIN_CONTENT_CHARS = 500`), so changing them is a deliberate act, not an accident.
**Do not retune blind** — measure against 5+ real careers pages first. Live data so
far: Odyssey and Hightouch both correctly landed on `fetch`.

Recovery if a company gets wrongly pinned: `setCareersUrl` resets `crawl_method` to
null, so re-saving the careers URL from the Watchlist page makes it retry the fetch tier.

### 2. A soft search-tier failure looks identical to "nothing is open"

`lib/crawler.ts` — the search prompt returns `{"roles": [], "message": "..."}` when it
finds nothing, and `rolesFromRaw` drops `message`. So "I could not access the site" and
"there are genuinely no roles" both become `status = 'empty'`.

Since the 2026-08-13 ruling let empty crawls close stale postings, two such runs can
close a live posting. Bounded by: the two-consecutive-run debounce, the
`source = 'Crawl' AND status = 'New'` scope, and the fact that a wrong close is a
reversible status flip. Revisit if the live pass shows soft failures are common.

### 3. The closure safety property is structural, not tested

`lib/crawler.ts` — closure can never fire on `error` or `needs_url` **because of where
the call sits** (inside the `else` branch, after the status assignment). A refactor that
hoisted it would break the property with all 63 tests still green. Not testable without
a DB harness. This is the highest-value target if one is ever added.

### 4. Case-sensitivity remains on the Discover path — FIXED (task 5)

Fixed for the crawler (`ingest-roles` uses `lower(company) = lower($1)`; `trackCompanyByName`
reuses an existing row's exact casing). **Not** fixed for `addToWatchlist` or Discover's
`watched.has(startup.company)` — so watching "clay" when "Clay" exists still creates a
second row, billed separately.

Closed in `fee58a6` — `fix: make company identity case-insensitive on the Discover path and
stop careers_url clobber` (task 5). `app/actions/watchlist.ts` gained a shared
`resolveExistingCompany` helper (SQL `lower()`-based) that `trackCompanyByName`,
`addToWatchlist`, `setTracking`, `markChecked`, `setCareersUrl`, and `removeFromWatchlist`
all now route through, so every write resolves to the row's exact stored casing before
filtering or upserting. This also closes the "third half" the original write-up didn't
name: `setTracking`/`markChecked`/`setCareersUrl`/`removeFromWatchlist` filtering with
`.eq("company", company)` on a casing mismatch used to match zero rows and silently no-op.
`getWatchedCompanyNames` was renamed to `getWatchedCompanyKeys` and now returns
`normalizeCompanyName`-keyed (lib/role-key.ts) entries; `components/Discover.tsx` compares
through the new `lib/watched-companies.ts#isCompanyWatched` helper everywhere instead of
raw-string `.has()` checks. Nothing in this item was left open.

### 5. `addToWatchlist` can clobber a hand-corrected careers URL — FIXED (task 5)

Re-watching a soft-disabled company from Discover overwrites `careers_url` with Discover's
guess when that guess is non-empty — potentially replacing a URL the user fixed by hand —
and does not reset `crawl_method` alongside it, bypassing the fix above.

Closed in the same commit as item 4. `lib/careers-url-precedence.ts#resolveCareersUrlWrite`
is the pure decision: an existing non-empty `careers_url` always wins (the column is omitted
from the write entirely); an existing empty/null value yields to a non-empty guess; both
empty stays empty. Whenever the guess actually wins, `addToWatchlist` now also resets
`crawl_method`, `last_crawl_status`, and `last_crawl_error` — matching `setCareersUrl`'s
existing reset — so a re-watched company isn't left pinned to a crawl tier learned about a
URL that's about to be replaced. Nothing in this item was left open.

### 6. Cron timing headroom

`--max-time 400` on the cron command vs `DEFAULT_BATCH_LIMIT = 3`. Measured reality: both
fetch-tier crawls took ~9s. A search-tier crawl is the unknown — if one appears and takes
~120s, three of them is 360s, close to the ceiling. Re-measure before raising the batch limit.

## Lower priority

- `crawl_runs` is written but no UI reads it. Spec §6.1 asks each Watchlist row to show
  "roles found on the last successful crawl"; not implemented. Currently needs psql.
- `resolveCareersUrl` swallows a `parseJson` throw with a bare `catch`, degrading silently
  to `needs_url` — the one remaining place that violates spec §7's "none are silent".
- `job_url` dedupe is exact string match (no trailing-slash / http-vs-https normalization).
  Can only miss a dedupe, never falsely suppress.
- `IngestResult.added` is in resolution order, not input order. Only `.length` is consumed.
- Orphaned `running` rows in `crawl_runs` if a deploy interrupts a batch. Nothing reaps them;
  benign, since reads filter on `status = 'ok'`/`'empty'`.
- `trackCompanyByName` on an already-tracked company silently re-crawls with no feedback.
- `?dry=1` writes nothing but still spends API calls — it is a rehearsal, not a free one.
- Watchlist UI polish: full-list reload flash on every row action; failure indicator is a
  paragraph rather than a pill; the track input clears even when tracking failed.
- `npm run lint` has never worked in this repo (no ESLint config; `next lint` blocks on an
  interactive prompt; adding a config makes `next build` fail on 3 pre-existing errors).
  Fixing it is a standalone task.

## Not built

`docs/superpowers/plans/2026-08-12-role-first-discovery.md` — role-first discovery
(search by job title and GTM stack rather than by company), the `"6-18m"` funding window,
and Discover's by-role mode. Written, reviewed, never executed. Spec §5 and §6.2 describe
behavior that does not exist yet.
