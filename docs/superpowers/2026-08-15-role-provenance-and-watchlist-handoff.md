# Role provenance chip + the silent watchlist crawl — handoff

**NOTHING BUILT. NOTHING DEPLOYED.** This is investigation only, from a session
that was accidentally opened in `app-builder-coach` and read this repo from the
outside. No file in this repo was changed. `main` is at `1f96c25`, working tree
clean.

Two questions were asked. Both are answered below with file:line evidence.
Where something was read from Railway rather than from the repo, it says so.
Where something is unverified, it says that too.

## Question 1 — can `/roles` show how each role was found?

Yes, and it is a render-only change. The data is already there.

`jobs.source` (db/schema.sql:26, typed lib/types.ts:106) is written on every
insert path, and the values already match the three buckets that were asked
about:

| How it was found | `jobs.source` | Written at |
|---|---|---|
| Discover → Find Roles (company/funding) | `Discover` | app/actions/roles.ts:144 |
| Discover → role search | `Role Search` | app/actions/role-search.ts:222 |
| Watchlist crawl (cron + "Check now") | `Crawl` | lib/crawler.ts:650 |
| Manual add | `Manual` | components/RolesTable.tsx:1033 |
| Recruiter role | `Recruiter` | components/RecruiterPanel.tsx:120 |

All five go through one insert, `addJob` (app/actions/jobs.ts:19-33), via
`ingestRoles` (lib/ingest-roles.ts:139-156) for the three automated paths.
`jobs.source` is never rewritten after insert.

**No query change is needed.** `getJobs()` is `.from("jobs").select("*")`
(app/actions/jobs.ts:6-17), called from the client component at
components/RolesTable.tsx:95, so `source` is already on every row. There is no
API route for the roles list — the only route in the app is the cron
(app/api/cron/crawl/route.ts).

**Where the chip goes:** components/RolesTable.tsx:724-737, the right-hand
badge cluster that renders `StageBadge` ("Series F") and `job.category`
("AI Infra"). Line 732-736 already renders a purple pill for
`source === "Recruiter"` — that is the precedent to generalize, not a new
pattern to invent. `SortKey` already includes `"source"`
(components/RolesTable.tsx:37), so a sortable Source column is half-wired.

**Do not merge this with the "via theladders.com" pill.** That is `SourceTag`
(components/RolesTable.tsx:873-883), derived from the *URL host* via
`classifyJobLink`, and it means "this link is second-hand" — not "this is how
we found it". Different concept, different column.

**Unverified:** whether any older rows have a null or unexpected `source`.
Nobody counted. Check before deciding whether the chip needs a fallback or the
table needs a backfill.

Casing trap: `jobs.source` is TitleCase; `watchlist.source` (db/schema.sql:103)
is lowercase `discover`/`manual` and describes the *company*, not the role.
Two vocabularies, do not unify them by accident.

## Question 2 — are watchlist companies queried regularly?

The schedule is real and healthy. It has also done nothing for three days.

Read from the Railway dashboard, not from this repo — the repo does **not**
contain the schedule. `vercel.json` has no `crons` key, there are no GitHub
workflows, no `railway.json`, no launchd plist, no pg_cron.

Project `gtm-job-search`, environment `production`, three services:

- `web` — online, https://jobs.tomkeefe.ai
- `Postgres`
- `crawler` — `cronSchedule: 0 13 * * *` (daily 13:00 UTC / 9am ET), start
  command `curl -sS --max-time 400 -H "Authorization: Bearer $CRON_SECRET"
  "$WEB_URL/api/cron/crawl"`

Note `--max-time 400`, where the checked-in plan
(docs/superpowers/plans/2026-08-12-company-tracking.md:2245-2260) specifies
`300`. The deployed command has drifted from the plan.

**The last three runs, from `railway logs --service crawler`:**

```
2026-08-13T13:03:42Z  dryRun=false crawled=0 totals={"newRoles":0,"failed":0} results=[]
2026-08-14T13:03:50Z  dryRun=false crawled=0 totals={"newRoles":0,"failed":0} results=[]
2026-08-15T13:03:15Z  dryRun=false crawled=0 totals={"newRoles":0,"failed":0} links={"checked":22,"relinked":0,"closed":0,"closedUnlisted":0,"unclear":[],"unresolved":7}
```

HTTP 200 every time. The job fires, authenticates, and completes. It simply
finds **zero companies due**. Link repair — which runs on every tick regardless
(app/api/cron/crawl/route.ts:114-125) — is the only part doing work.

Due-selection is `DUE_COMPANIES_SQL` (lib/crawl-schedule.ts:14-27):
`tracking_enabled = true AND (last_checked_at IS NULL OR last_checked_at <=
now() - crawl_interval_days)`, oldest first, batch `DEFAULT_BATCH_LIMIT = 3`
(lib/crawl-schedule.ts:12). Default interval is 7 days (db/schema.sql:97-103),
so 3/day × 7 sustains ~21 tracked companies.

**So `crawled=0` means one of two things, and nobody has checked which:**

1. No watchlist row has `tracking_enabled = true` — the watchlist is not being
   queried for jobs at all, despite a green cron. Most likely.
2. Every tracked company was checked within the last 7 days — benign.

This is the first thing to diagnose. Query `watchlist` for
`count(*) filter (where tracking_enabled)` and `min(last_checked_at)`.

Stale doc, fix while you are in there: CLAUDE.md:107 still says "up to 10"
companies per run. It is 3.

## Also found, unrelated to either question

**This repo's GitHub remote is an orphan.** `origin` is
`https://github.com/tkeefe66/gtm-job-search.git`, and `origin/main` is a single
commit `ad4e7a1 "Snapshot of current app state"` with **no common ancestor**
with local `main` — `git merge-base HEAD origin/main` returns empty. The 162
local commits have never been pushed and cannot fast-forward.

Railway is unaffected: `web`'s active deployment came from a `railway up` CLI
upload (2026-08-15T15:13Z), not from GitHub. But GitHub is not a backup of this
work.

If you push: run the `pre-push-history-audit` skill first. This repo's history
touches `CRON_SECRET` and Supabase keys, and force-pushing 162 commits over a
snapshot is exactly when a committed-then-deleted `.env` surfaces.

Naming drift worth cleaning up: the local directory is now `gtm-job-search`
(renamed from `chad-job-search-main`), the GitHub repo is
`tkeefe66/gtm-job-search`, and Railway's configured service source still reads
`tkeefe66/chad-job-search`.

## Suggested order

1. **Diagnose the watchlist.** The chip will render `Crawl` on rows a broken
   crawler is not producing. Fix the cause first.
2. **Add the provenance chip.** ~15 lines, one file, no schema or query change.
3. **The GitHub history**, whenever — but not before the secret audit.
