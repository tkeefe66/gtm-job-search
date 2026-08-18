# Hiding roles that were never live — design

Date: 2026-08-17
Status: approved for planning

## The problem

`/roles` shows two tiles, "N open" and "N out". "Out" counts every row whose
status sits in the terminal bucket, which conflates three different things:

1. Roles the user actively passed on — `Not Interested`, `Rejected`, `Passed`.
2. Roles that were live and later died — closed by the crawler's stale-posting
   pass or by the "Check links" 404/410 re-check.
3. Roles that were **already gone when the app first found them**. `ingestRoles`
   calls `checkJobUrl` at save time; a definitive 404/410 stores the row as
   `Posting Closed` with fit-scoring skipped entirely.

Only (1) is a decision the user made. Category (3) is noise: postings there was
never an option to apply to. It should not appear in the table or in either tile
count.

## Verified against production, not assumed

Read-only probe, 2026-08-17, against `DATABASE_PUBLIC_URL` (73 jobs, 1 tenant):

| status | rows | `fit_score` null | scored |
| --- | --- | --- | --- |
| Posting Closed | 29 | **15** | 14 |
| New | 23 | 0 | 23 |
| Not Interested | 21 | 0 | 21 |

Tiles today: 23 open / 50 out (29 + 21). The 15 candidates are corroborated by a
second, independent signal:

- All 15 `Posting Closed AND fit_score IS NULL` rows have
  `updated_at = created_at` — inserted and never touched again. That is the
  ingest signature.
- All 14 scored `Posting Closed` rows were touched hours-to-days after insert.
  That is the crawler / link-health signature.
- **Zero** rows anywhere carry a null `fit_score` outside `Posting Closed`, so
  the "a scoring failure also leaves it null" ambiguity does not exist in this
  data.
- `app_settings` has no `job_statuses` row: statuses are entirely shipped
  defaults, with no user customisation to preserve.

The 15 rows are 9× Databricks (one 08-15 Discover run) plus AgentSync, DaVita,
dbt Labs, Groq, Workiva and Wpromote.

## Why not a new system status

The user's first instinct was a fourth `SystemStatusKey`, e.g. `Never Live`.
Rejected, for four reasons that compound:

- **It is not a workflow state.** "Never live" is a provenance fact stamped once
  at insert and never changed. A status is something the user moves a row into;
  this would appear in the `StatusEditor` list and in every row's dropdown as
  something assignable by hand, which is meaningless.
- **It collides with the `hidden: false` rule.** `resolveStatuses` forces
  `hidden: false` for every system status, deliberately: `db/schema.sql` defaults
  the column to `New` and two form defaults seed it in state, so a hideable
  system status would let a form save a status the user never picked. Hiding a
  new system status means loosening or special-casing that rule.
- **It needs a third `StatusBucket`,** which ripples into `bucketFor`'s
  "an unrecognised key is active" default, `tileCounts`, the Open/Out sentinel
  filters in `RolesTable`, and `link-health.ts:91`'s `!== "terminal"` check —
  four load-bearing invariants disturbed to record one immutable bit.
- **A column touches none of them.** `getJobs` is the only reader that feeds the
  table, and `tileCounts` derives from the same array, so one partition removes
  these rows from the table and both tiles at once.

A third option — deriving it at read time as
`status === "Posting Closed" && fit_score === null`, with no schema change — was
also rejected. It is exact against today's data but implicit: any future closed
row that failed to score would vanish silently, and the signal is not exclusive
by construction.

## The rows cannot be deleted

`ingestRoles` (`lib/ingest-roles.ts`) dedupes by reading **every** existing job
for the company regardless of status, then skipping any incoming role that
matches on normalised role key or exact `job_url`. Delete the dead rows and the
next Find Roles run re-finds, re-verifies and re-inserts the same dead postings,
permanently. The row stays; only its visibility changes. Nothing in this design
touches that query, so the dedupe keeps seeing hidden rows.

## Design

### 1. Schema

`db/schema.sql`, alongside the other idempotent alters:

```sql
alter table jobs add column if not exists never_live boolean not null default false;
```

Default `false`, so applying it against the running build is inert.

The alter also lives in `db/migrations/008_never_live.sql`, which is the
mechanism an EXISTING database is actually migrated through
(`db/migrate.mjs`) — `db/schema.sql` stays the fresh-install bootstrap only.
See §8.

### 2. Write site

`lib/ingest-roles.ts` closes a role on two signals, and they now split:

```ts
const deadUrl = urlStatuses[i] === "dead";
const isDead = deadUrl || links[i].unlisted;   // still closes on either
...
status: isDead ? "Posting Closed" : "New",
never_live: deadUrl,                            // hides on the definitive one only
```

**`never_live` is deliberately narrower than `isDead`.** `unlisted` means the
employer's board was found — by GUESSING a slug from the company name — and does
not list the title. `repairJobLinks` already refuses to close a role on that
signal, because a slug collision would kill a live role against a stranger's
board. Hiding an inference invisibly is worse still: dedupe stops the next run
re-finding it, so a wrong guess disappears a live role permanently with nothing
on screen. Board-absent rows stay visible as `Posting Closed` in the Out tile.

### 3. Type

`never_live: boolean` on `Job` (`lib/types.ts`). `JobInsert` picks it up through
its existing `Partial<Omit<Job, …>>`.

### 4. Read boundary

New pure module `lib/never-live.ts`:

```ts
export function partitionNeverLive(jobs: Job[]): { visible: Job[]; hiddenCount: number }
```

`getJobs` (`app/actions/jobs.ts`) returns `{ jobs, hiddenCount, error? }`,
partitioning after the read. Partitioning in TypeScript rather than adding a SQL
`WHERE` gets the count with no second round trip and leaves the query untouched.

A row read before the migration lands as `undefined` and is treated as visible —
the check is `=== true`, so it fails open, never fail-hidden. The failure path
returns `hiddenCount: 0`.

### 5. UI

`components/RolesTable.tsx` renders one muted line under the tiles, only when
`hiddenCount > 0`:

> 15 hidden — found already closed

`hiddenCount` is adopted in the same success branch as `setJobs`, so a failed
load cannot print a stale number (`getJobs` returns `error.message` verbatim and
a connection-level failure carries an EMPTY one — presence, not truthiness; see
`.claude/skills/swallowed-string-errors`).

Tiles, filters and `tileCounts` are untouched: they derive from `jobs`, which no
longer carries these rows.

### 6. Back-fill

One-shot `db/backfill-never-live.mjs`, dry-run by default and `--apply` to
write, reading `DATABASE_PUBLIC_URL || DATABASE_URL` and printing the error
channel explicitly on both connect and query.

```sql
update jobs set never_live = true
 where status = 'Posting Closed' and fit_score is null
   and updated_at = created_at and never_live = false;
```

Verified to match exactly the 15 rows above. It is a one-shot script rather than
a line in `db/schema.sql` so that re-applying the schema can never re-decide
history against future data.

**The historical asymmetry, accepted deliberately.** Going forward, `unlisted`
rows stay visible. Historically they cannot: ingest never recorded which signal
fired, so the back-fill hides all 15 under a rule the code will no longer apply.
Thirteen of the fifteen are structurally provable 404/410s — their hosts
(`databricks.com`, `job-boards.greenhouse.io`, `jobs.lever.co`, `themuse.com`)
are none of them in `AGGREGATOR_HOSTS`, so `upgradeLink` returned early and
`unlisted` was impossible. Only the two `builtin.com` rows are ambiguous, and
both are hidden.

### 7. Tests

- `lib/never-live.test.ts` — the partition: hides `true`, keeps `false`, keeps a
  pre-migration `undefined`, and the count matches what was removed.
- `lib/ingest-roles.test.ts` — three cases asserting the `addJob` payload: dead
  URL → `status: "Posting Closed", never_live: true`; unlisted → `status:
  "Posting Closed", never_live: false`; alive → `status: "New", never_live:
  false`.
- `lib/job-statuses.test.ts` and the three `lib/__fixtures__/fit-prompt.*.txt`
  fixtures stay **untouched**. That they need no edit is the evidence that the
  status machinery and fit scoring did not move.

Gate: `npm run build && npm test` (`npm run lint` is non-functional in this
repo).

### 8. Deploy order is load-bearing

Schema first, always:

1. Apply `db/migrations/008_never_live.sql` against production via
   `db/migrate.mjs`, not `db/apply-schema.mjs` — `schema.sql` still contains
   `create table if not exists insights_cache`, a table migration 006 has
   since dropped, and applying it whole would re-create that table with no
   `tenant_id` column or RLS policy. Adding a column defaulted `false` is
   inert against the running build. Deploying the code first would make every
   `addJob` insert fail against a table with no `never_live` column.
2. Run the back-fill dry-run, review the 15 rows, then `--apply`.
3. Push to `main`; Railway auto-deploys the `web` service from GitHub.
4. Verify `railway deployment list --service web --limit 1 --json`'s
   `meta.commitHash` against `git rev-parse origin/main` before believing any
   check against the live site.
5. Confirm the tiles read **23 open / 35 out**, with "15 hidden" beneath them.

## Non-goals

- **No UI to un-hide a row.** If one is wrongly hidden, the fix is a one-line SQL
  update. Building an escape hatch for a case that has not happened is the
  feature this design is trying not to grow.
- **No change to what gets CLOSED.** `isDead` still closes on either signal;
  only what gets HIDDEN narrows.
- **No change to the status vocabulary.** `SystemStatusKey`, `resolveStatuses`,
  `SYSTEM_BUCKET`, `tileCounts` and `StatusEditor` are all untouched.
- **No change to fit scoring.** The three fit-prompt fixtures pin that.
