# User-editable job statuses — design

**Status:** revision 3, 2026-08-15. Not yet implemented. Not yet approved —
revision 3 changes visible UI (the tile row) and needs a decision on that.

Revision 2 went to three independent adversarial reviews and did not survive
them. Four findings were structural rather than cosmetic, and one was
embarrassing: revision 2's marquee correction was *"revision 1 cited a dead write
site,"* and revision 2 cited a different dead write site in the same table. Its
line numbers were also stale throughout, computed against code that `5502b41` had
already moved — while its own preamble asserted every citation held.

**Every `file:line` in revision 3 was re-derived against `HEAD` after `5425bb7`.**

## Problem

The status dropdown on `/roles` ships thirteen values and none can be changed. A
user whose process has no "Exec Presentation" step sees it on every row forever.

The list is a TypeScript union at `lib/types.ts:1-14`, mirrored into three arrays
(`JOB_STATUSES` `:16`, `ACTIVE_STATUSES` `:32`, `TERMINAL_STATUSES` `:42`) that
drive the dropdown, the filter chips, the count tiles, and — less obviously —
which roles the link-health pass re-verifies.

**Scale check, production 2026-08-15:** 73 rows. `Posting Closed` 29, `New` 23,
`Not Interested` 21. That sums to 73, so **every other status has zero rows —
including `Applied`**. The entire application-pipeline half of this app has never
been used.

Two reviewers argued from that number that the honest feature is deleting the ten
unused statuses — one line, no new files — and that add/rename/delete is
machinery for a pipeline with no observed use. **That argument is recorded and
was overruled deliberately:** the feature is wanted, and a prune cannot add
"Take-home". But it sets the bar for complexity. Revision 3 removes every
mechanism that is not load-bearing, and the reviewers' count of incidental
machinery is why.

## What the user asked for

Reorder, rename, hide, add, delete. Plus an editable active/terminal
classification, and load-bearing statuses renamable but not deletable.

## The constraint that shapes everything: some statuses are load-bearing

Written or read by code, not merely displayed. Deleting them breaks a path with
no error anywhere.

| Key | Touched at | Consequence if it stops existing |
|---|---|---|
| `New` | Written: `lib/ingest-roles.ts:142`, `components/RolesTable.tsx:1044` (`EMPTY_ADD`), `components/RecruiterPanel.tsx:37`. **Read in raw SQL**: `lib/crawler.ts:427` (`STALE_POSTING_CANDIDATES_SQL`), `lib/removed-titles.ts:68` (`CRAWL_TITLE_MATCH_SQL`). **Column default**: `db/schema.sql:14` | Ingest has nowhere to put a role; stale-posting closure stops matching |
| `Posting Closed` | `lib/ingest-roles.ts:142`, `app/actions/link-health.ts:139,163`, `lib/crawler.ts:490` | Link repair and the crawler write a phantom status |
| `Applied` | `lib/applied-date.ts` via `handleStatus`, `handleBulkStatus`, `AddPanel`, and `RecruiterPanel` — **four** paths as of `5425bb7`, not two | `applied_date` stops being stamped |

**`Offer` is no longer on this list.** Revision 2 protected it because
`RolesTable` hardcodes an Offer count tile. That is circular — a status made
undeletable because the UI hardcoded a tile for it. Revision 3 makes the tile row
config-driven, and `Offer` becomes an ordinary deletable status.

`SYSTEM_STATUS_KEYS` is therefore exactly **three**: `New`, `Posting Closed`,
`Applied`. Revision 2 said "all five system rows" above a four-row table; the set
is now enumerated and its size stated once.

`ACTIVE_STATUSES` / `TERMINAL_STATUSES` are not cosmetic groupings:

- `app/actions/link-health.ts:78` skips terminal roles, so the terminal set
  decides **which roles cost a liveness check**.
- `components/RolesTable.tsx:228` — the default `"Open"` filter hides terminal
  rows, so the terminal set decides **what you see on load**.

## Storage is already free-form

`db/schema.sql:14` is `status text not null default 'New'` — no CHECK, no enum.
`Job.status` (`lib/types.ts:94`) is already `JobStatus | string`. All 73 rows hold
one of the shipped thirteen, so **no data migration is required**.

## Design

### Two buckets, not three

```ts
export type StatusBucket = "active" | "terminal";

export type JobStatusDef = {
  key: string;        // immutable; what jobs.status stores
  label: string;      // displayed; freely editable
  bucket: StatusBucket;
  hidden: boolean;
  system?: SystemStatusKey;
};
```

Revision 2 had a third `neutral` bucket, and it seeded most of the spec's
incidental complexity — it forced an `Other` chip, which forced an invariant
test, which **failed against the shipped default config**: `New` and `Offer` are
in neither `ACTIVE_STATUSES` (`lib/types.ts:32-40`) nor `TERMINAL_STATUSES`
(`:42-47`), so both would default to `neutral` and count twice, once in their own
tile and once in Other. The spec's proudest invariant was red before any user
edit.

Two buckets, with defaults read off today's behavior rather than invented:
**`active` is everything the `"Open"` filter shows and link-health checks** — the
seven in `ACTIVE_STATUSES`, plus `New` and `Offer`. **`terminal` is the four in
`TERMINAL_STATUSES`.** That is exactly what the app does today, so the default
config is a no-op by construction, and a test pins it against `lib/types.ts`
rather than a hand-copied list.

### The tile row becomes config-driven — a visible change needing approval

`RolesTable.tsx:183-210` counts into four hardcoded buckets and `:212-217` renders
four tiles with hardcoded labels, comparing status by **string literal**:

```ts
if (j.status === "New") c.New++;
else if (ACTIVE_STATUSES.includes(...)) c.Active++;
else if (j.status === "Offer") c.Offer++;
```

Rename `New` to `Fresh` and the row above the table still reads "New", counting
on a literal the user can no longer see. Revision 2 never touched this, so rename
would have shipped visibly half-done.

**Proposed:** two tiles — **Open** (bucket `active`) and **Out** (bucket
`terminal`) — plus the per-status chip row that already exists at
`RolesTable.tsx:552-567` and is config-driven by construction. Every job lands in
exactly one tile, so the sum invariant is true by definition rather than by test,
and the `Other` chip, the hardcoded literals, and the branch-order hazard all
disappear together.

**This changes what you see.** New/Active/Offer/Out becomes Open/Out. Flagged
rather than assumed — if four tiles are wanted, the alternative is a
`pinned: boolean` on `JobStatusDef` with `New` and `Offer` pinned by default,
which keeps four tiles at the cost of one more field and its ordering rules.

### Keys are immutable; labels are presentation

Built-in keys are exactly today's stored strings. Custom statuses get a slug key
derived from their label at creation, immutable afterward.

**Rejected alternative:** store the label and `UPDATE` all rows on rename. It
cannot rename the system statuses — their literals are in `lib/crawler.ts:427`,
`lib/removed-titles.ts:68`, and `db/schema.sql:14`, none reachable from
`/settings`.

**No reserved-key list.** Revision 2 needed `slugify` to blacklist `All`, `Open`,
`Active`, `Out`, `Other` because `statusFilter` is
`useState<JobStatus | "All" | "Active" | "Out" | "Open">` (`RolesTable.tsx:59`) —
sentinels and status keys sharing one string namespace. Fix the state instead:
`{ kind: "sentinel" | "status"; key: string }`. Collisions become impossible, the
blacklist disappears, and filter reconciliation reduces to
`kind === "status" && !byKey.has(key)`. Smaller than the rule it replaces.

### The module splits in two

Revision 2 specified `lib/job-statuses.ts` as both *pure and testable* and *the
module that reads the `app_settings` row*. Those are incompatible: reading the row
imports `lib/settings-store.ts`, which imports `@/lib/supabase`, which imports
`pg` — into a module both client components would import. This repo documents that
hazard twice, at `components/Settings.tsx:35-39` and `lib/bulk-status.ts:1-6`.

- **`lib/job-statuses.ts`** — pure, no supabase import, safe in the client bundle.
  Exports `JobStatusDef`, `StatusBucket`, `SystemStatusKey`, `SYSTEM_STATUS_KEYS`,
  `DEFAULT_STATUSES`, `STATUS_STYLES`, `resolveStatuses`, `slugify`, `labelFor`,
  `activeKeys`, `terminalKeys`, **`optionsFor`**, **`tileCounts`**,
  **`compareByConfig`**.
- **The read** lives in `lib/settings-store.ts`, which already imports supabase,
  and returns the raw jsonb value. `resolveStatuses` validates it.

The last three exports are new and exist so the tests below can be written in
`environment: "node"` — see Testing.

### Where it is stored

One `app_settings` row under a **standalone `JOB_STATUSES_KEY` constant**, not a
member of `SETTING_KEYS`.

Revision 2 added a fourth shape group, `JSON_SETTING_KEYS`, and consequently had
to edit two green tests. Its stated reason was that `SettingKeysAreFullyClassified`
(`lib/settings-store.ts:55-57`) rejects an array-of-objects — but that assertion
only constrains keys that are *in* `SETTING_KEYS`, so the compile error was a
consequence of revision 2's own choice, not a reason for it. The repo already has
the right precedent: `CRITERIA_CHANGED_AT_KEY` and `COMP_SCORING_RESCORED_AT_KEY`
live outside `SETTING_KEYS` precisely because they do not go through
`mergeSettings`. Neither does this.

Consequences: no fourth group, and **no edits to `lib/settings-store.test.ts`** —
revision 2's claim that the shape test at `:301-315` fails was also wrong; it
iterates only the three existing groups and never touches a fourth.

`getSettings()` still returns the statuses off its existing single
`select key, value from app_settings`, preserving the one-snapshot guarantee.

### Side effects on save

`CACHES_TO_CLEAR[jobStatuses] = []`, `AFFECTS_CRAWL` excludes it,
`PATHS_TO_REVALIDATE[jobStatuses] = []`.

The empty revalidation list is correct, but **not for the reason revision 2
gave**. It claimed "/roles is a client component that fetches for itself";
`app/roles/page.tsx` is an `async` server component with `force-dynamic` that
calls `readCompFloor()` and passes it as a prop — per `lib/settings-effects.ts` it
is the *only* route that renders a setting. The real reason is narrower: statuses
are fetched client-side by `RolesTable`, so there is nothing server-rendered to
revalidate. Pinned by `lib/settings-effects.test.ts:154-163` and `:165-169`.

### Deleting a status

Blocked while rows hold it, with the count shown and a reassign picker.

**Reassignment targets are guarded.** Revision 2 guarded `New → terminal` and
`Posting Closed → active` as "silent footguns" and left a strictly larger one
open: **reassigning rows *into* `New` hands them back to the automation.**
`lib/crawler.ts:414-427` is explicit that a row the user moved out of `New` is
theirs and no automated process may touch it; `STALE_POSTING_CANDIDATES_SQL`
(`:427`) and `CRAWL_TITLE_MATCH_SQL` (`lib/removed-titles.ts:68`) both key on
`status = 'New'`. Reassigning 21 `Not Interested` rows into `New` re-arms
stale-posting closure against them. Reassigning any terminal status into an active
one also re-arms the liveness billing at `app/actions/link-health.ts:78`.

Rule: **`New` is never a reassignment target**, and terminal → active warns inline
with the row count and the billing consequence.

**Ordering:** reassign first, then save the config. A failure between leaves rows
on a key still in the list. Stated plainly, because revision 2 called this
"harmless" and it is only *consistent*: the `UPDATE` lands, the save fails, the UI
says "save failed", and the user reads that as *nothing happened* while N rows of
hand-entered triage have been relabeled with no undo and — per the sibling
multi-tenant spec — no backups. The status column is the only user-authored data
in this app. **Therefore: the confirm dialog states the row count and that the
move is not reversible, and the reassign result reports how many rows moved.**

### Error contract

Per `.claude/skills/swallowed-string-errors`, all four actions return
`{ error?: string }` with the driver's message verbatim, empty string included,
and every caller branches on presence via
`describeWriteFailure(...) !== undefined`.

- `saveJobStatuses(defs)` — write.
- `reassignStatus(fromKey, toKey)` — write; returns rows affected.
- `countJobsByStatus()` — read. **Must carry an error channel**: a failed count
  reading as `0` silently unlocks the delete guard.
- `getJobStatuses()` — read. **Also carries an error channel**, which revision 2
  omitted while spending a whole section forbidding exactly that.
  `loadJobStatuses()` returning `DEFAULT_STATUSES` on failure means a transient
  read error silently restores hidden statuses, reverts renames, and lets the user
  write a status not in their config. `RolesTable` must distinguish "your config"
  from "the database is unreachable" — the same argument `RolesTable.tsx:104`
  already applies to `getJobs()`.

**Tenant safety, now rather than later.** The sibling spec
`2026-08-15-multi-tenant-auth-design.md` adds `tenant_id` to `jobs`.
`reassignStatus` as specified is `UPDATE jobs SET status = ... WHERE status = ...`
with no row-owner predicate — it would rewrite **every tenant's** rows, the same
defect class as `applySideEffects`'s unqualified
`` rawQuery(`delete from ${table}`) `` at `app/actions/settings.ts:135`, which four
reviews flagged. `countJobsByStatus()` would count the platform. Neither goes
through `QueryBuilder`, so a tenant-table registry would not see them. Write both
with an explicit owner predicate from the start: a no-op filter today, the
difference between a scoped update and a platform-wide one later.

**Concurrency:** whole-array replace, last-write-wins across tabs. Accepted.

### Hiding

A hidden status leaves the dropdown, **but the currently selected value is always
injected as an option**. `StatusSelect` (`RolesTable.tsx:978-989`) is the row
renderer as well as the editor — a `<select value={v}>` whose `value` matches no
`<option>` renders the *first* option instead, so hiding `Not Interested` would
make all 21 rows holding it display something else while the database disagrees.
Same at `RecruiterPanel.tsx:266` and the add form at `RolesTable.tsx:1198`.

**System statuses cannot be hidden.** Revision 2 guarded their *buckets* and left
hiding open, which is worse: `db/schema.sql:14` still defaults to `New`,
`lib/ingest-roles.ts:142` still writes it, and the two form defaults
(`RolesTable.tsx:1044`, `RecruiterPanel.tsx:37`) still seed `"New"` in state. The
form would *display* the first visible option while `form.status` stayed `"New"`,
saving a status the user never selected. The injection rule covers row rendering;
it does not cover a form default that was never a selection.

### Bucket guards

`New` may not be terminal; `Posting Closed` may not be active. Enforced in
`resolveStatuses`, pinned by tests. Other bucket changes warn inline and are
allowed.

### Resolution and failure behavior

`resolveStatuses` repairs rather than rejects, in order: missing system key
re-appended with its default; duplicate keys — first wins; unknown bucket →
`active`; empty label → the key; system bucket violations reset; `hidden` forced
false on system keys. A repaired config is used, not written back.

## Components

| File | Change |
|---|---|
| `lib/job-statuses.ts` | NEW, pure. Exports listed above |
| `lib/job-statuses.test.ts` | NEW |
| `lib/types.ts` | `JobStatus` narrows to `SystemStatusKey`; the three arrays deleted after `DEFAULT_STATUSES` is derived from them |
| `lib/settings-store.ts` | Standalone `JOB_STATUSES_KEY`; raw read |
| `lib/settings-effects.ts` | Two `[]` entries |
| `lib/settings-view.ts` | `statuses` added to `SettingsView` (`:21`) |
| `app/actions/settings.ts` | `saveJobStatuses`, `countJobsByStatus`, `reassignStatus` |
| `app/actions/jobs.ts` | `getJobStatuses()` with an error channel; also drop the unused `JobStatus` import at `:4` |
| `components/Settings.tsx` | New editor — see below |
| `components/RolesTable.tsx` | Fetch; tagged filter state; config-driven tiles; sort by config index; injected option; **delete dead `EMPTY_FORM` at `:1032`**; label in the `handleStatus` banner at `:281` |
| `components/RecruiterPanel.tsx` | Fetch; injected option |
| `components/ui.tsx` | Delete `StatusBadge` + its map — and `SeniorityBadge` (`:26`) and `Stars` (`:52`), also unimported |
| `lib/bulk-status.ts` | **No change.** `summarizeBulkStatus(results, status: string)` is already `string`; the label belongs at the two call sites |
| `app/actions/link-health.ts` | Terminal set from config |
| `lib/crawler.ts`, `lib/ingest-roles.ts` | No change — they write system keys |

### `components/Settings.tsx` has no slot for this

Revision 2 said "new 'Pipeline statuses' section" and estimated ~15 files.
`Settings.tsx` is **842 lines** built on a section-keyed model — `Section` union,
`LABELS`, `Draft`, `EMPTY_DRAFT`, `draftFrom`, and `syncSection`'s exhaustive
switch with no `default`, so a new member is a compile error. `Draft` is all
`string`/`boolean`; a `JobStatusDef[]` does not fit it.

The statuses editor is therefore **its own component with its own local state**,
rendered inside `Settings.tsx` but outside the `Draft` machinery, saving through
`saveJobStatuses` directly. And `package.json` has **no drag-and-drop
dependency**, so reorder is up/down buttons — not drag — unless one is added.

### `JobStatus` narrowing is a type break, not a soft loss

Revision 2 framed it as losing exhaustiveness. `RolesTable.tsx` annotates
`JobStatus` at `:59, :213, :215, :276, :330, :646, :745, :978, :983, :1033, :1042`
— including `handleStatus(job, status: JobStatus)` and `StatusSelect`'s props,
both of which must accept arbitrary config keys afterward. Each needs retyping to
`string`. Note `lib/applied-date.ts` deliberately went the *other* way in
`5425bb7`, typing `status: JobStatus` so a rename is a compile error; it stays
`SystemStatusKey`-typed, which is correct and unaffected.

## Testing

`vitest.config.ts` is `environment: "node"` and includes only `lib/**/*.test.ts`
and `app/**/*.test.ts` — no `.tsx`, no jsdom, no testing-library, and no
`.test.tsx` file exists. **Four of revision 2's ten tests could not have been
written**, because they targeted JSX behavior with no pure function to bind to.
That is why `optionsFor`, `tileCounts`, and `compareByConfig` are now exports.

1. Every system key survives an arbitrary saved config, including one omitting it.
2. `New` always resolves.
3. Duplicate keys collapse to one.
4. A malformed or absent row yields exactly `DEFAULT_STATUSES`.
5. `slugify` never collides with an existing key.
6. `New` cannot be terminal; `Posting Closed` cannot be active; system keys cannot
   be hidden.
7. **`DEFAULT_STATUSES` buckets match `ACTIVE_STATUSES` / `TERMINAL_STATUSES` plus
   `New`/`Offer` as active** — pinned against `lib/types.ts`, not a copy.
8. `optionsFor(config, current)` contains `current` even when hidden.
9. `tileCounts` — every job lands in exactly one tile, for any config.
10. `compareByConfig` orders by config index, not by label or key.

Dropped as unwritable without a DOM stack, and stated rather than silently
omitted: direct assertions on the three `<select>` render sites, covered
indirectly by test 8.

Two of revision 2's tests were also vacuous and are gone: "no key is in both the
active and terminal sets" cannot be violated when `bucket` is a single field, and
"reordering changes order but no key" tested that array order is array order.

`npm run build && npm test` is the gate.

## Consequences worth accepting

- The compiler's status guard weakens at the 11 annotations listed above.
  `Job.status` is already `JobStatus | string` and
  `updateJob(id, patch: Partial<Job>)` already accepts a typo today, so the loss
  is narrower than revision 1 claimed — but it is a real break, not a soft one.
- **CLAUDE.md's "Status/filter machinery is constant-driven" paragraph becomes
  wrong**, including its "to add a status: extend the union + arrays" instruction.
- The tile row changes shape, pending the decision above.

## Out of scope

- Per-status colors for custom statuses (neutral grey fallback).
- `PipelineStatus` (`lib/types.ts:50`) — verified **zero** consumers repo-wide.
- Making the two config writes atomic; ordering plus an explicit warning covers it.
- Drag-to-reorder.

## Review corrections (revision 2 → 3)

1. **The chip invariant failed on the default config.** `New` and `Offer` are in
   neither status array, so `neutral` double-counted them. `neutral` is gone; two
   buckets, defaults derived from `lib/types.ts`.
2. **`lib/job-statuses.ts` was specified as pure *and* as the row reader** — it
   would have dragged `pg` into the client bundle. Split.
3. **Four of ten tests were unwritable** in a node-only vitest setup. Three pure
   functions extracted; the unwritable ones named as dropped; two vacuous ones
   removed.
4. **`getJobStatuses()` had no error channel** while the spec forbade exactly that
   for `countJobsByStatus()`.
5. **Every line number was stale** by ~12 lines. All re-derived at `HEAD` after
   `5425bb7`.
6. **`EMPTY_FORM` (`RolesTable.tsx:1032`) is dead** — one reference, its own
   definition. Revision 2 cited it as a `New` write site, repeating the exact error
   its own correction #1 claimed to have fixed. Now deleted instead.
7. **`Offer` was protected circularly** — undeletable because a tile hardcoded it.
   Tile row is config-driven; `Offer` is ordinary.
8. **"All five system rows" sat above a four-row table.** The set is three.
9. **Hiding was unguarded for system statuses**, worse than the bucket moves that
   were guarded, because the two form defaults seed `"New"` in state.
10. **Reassignment targets were unguarded** — reassigning into `New` hands rows
    back to stale-posting closure and re-arms liveness billing.
11. **`bulk-status.ts` needed no change**; its parameter is already `string`. The
    twin at `RolesTable.tsx:281` was missed.
12. **The `mergeSettings` reasoning was a non-sequitur**, and the second claimed
    test failure did not exist. Standalone key; zero test edits.
13. **"/roles is a client component" is false** — it is an async server component
    with `force-dynamic`. Conclusion unchanged, reason corrected.
14. **`Settings.tsx`'s `Draft` model cannot hold this**, and there is no DnD
    dependency. Both now stated.
15. **Tenant-unsafe writes** flagged, per the sibling spec's review.
16. **Scope objection recorded and overruled**, with the zero-`Applied`-rows number
    stated so the decision is visible rather than implied.
