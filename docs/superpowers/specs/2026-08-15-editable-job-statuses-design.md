# User-editable job statuses — design

**Status:** revision 4, 2026-08-17. Not yet implemented. **The tile-row decision
that blocked revision 3 is made: two tiles, Open / Out** (§"The tile row becomes
config-driven"). Ready for implementation planning.

Revision 2 went to three independent adversarial reviews and did not survive
them. Four findings were structural rather than cosmetic, and one was
embarrassing: revision 2's marquee correction was *"revision 1 cited a dead write
site,"* and revision 2 cited a different dead write site in the same table. Its
line numbers were also stale throughout, computed against code that `5502b41` had
already moved — while its own preamble asserted every citation held.

Revision 3 asserted the same discipline and then decayed the same way: two days
of commits moved nearly every site it cited, by 1 to 6 lines, and two of its
claims about tenant scoping went stale because the defects were fixed.

**Every `file:line` in revision 4 was re-derived against `e8b6b1b`.** A citation
here is worth exactly as much as the date on this line — re-derive before
implementing, do not trust this file's numbers on sight.

## Problem

The status dropdown on `/roles` ships thirteen values and none can be changed. A
user whose process has no "Exec Presentation" step sees it on every row forever.

The list is a TypeScript union at `lib/types.ts:1-14`, mirrored into three arrays
(`JOB_STATUSES` `:16`, `ACTIVE_STATUSES` `:32`, `TERMINAL_STATUSES` `:42`) that
drive the dropdown, the filter chips, the count tiles, and — less obviously —
which roles the link-health pass re-verifies.

**Scale check, production 2026-08-15 — NOW STALE, re-run before implementing:**
73 rows. `Posting Closed` 29, `New` 23, `Not Interested` 21. That sums to 73, so
**every other status had zero rows — including `Applied`**. The entire
application-pipeline half of this app had never been used.

Two nightly crawls and any manual triage have happened since. The number matters
to two decisions below — whether a data migration is needed, and whether the
delete guard will ever fire in practice — so re-run it rather than quoting it:

```sql
select status, count(*) from jobs group by status order by count(*) desc;
```

Two reviewers argued from that number that the honest feature is deleting the ten
unused statuses — one line, no new files — and that add/rename/delete is
machinery for a pipeline with no observed use. **That argument is recorded and
was overruled deliberately:** the feature is wanted, and a prune cannot add
"Take-home". But it sets the bar for complexity. This design keeps only
mechanism that is load-bearing, and the reviewers' count of incidental
machinery is why.

## What the user asked for

Reorder, rename, hide, add, delete. Plus an editable active/terminal
classification, and load-bearing statuses renamable but not deletable.

## The constraint that shapes everything: some statuses are load-bearing

Written or read by code, not merely displayed. Deleting them breaks a path with
no error anywhere.

| Key | Touched at | Consequence if it stops existing |
|---|---|---|
| `New` | Written: `lib/ingest-roles.ts:145`, `components/RolesTable.tsx:1038` (`EMPTY_ADD`), `components/RecruiterPanel.tsx:37`. **Read in raw SQL**: `lib/crawler.ts:430` (`STALE_POSTING_CANDIDATES_SQL`), `lib/removed-titles.ts:69` (`CRAWL_TITLE_MATCH_SQL`). **Column default**: `db/schema.sql:14` | Ingest has nowhere to put a role; stale-posting closure stops matching |
| `Posting Closed` | `lib/ingest-roles.ts:145`, `app/actions/link-health.ts:140,164`, `lib/crawler.ts:494` | Link repair and the crawler write a phantom status |
| `Applied` | `lib/applied-date.ts` via `handleStatus`, `handleBulkStatus`, `AddPanel`, and `RecruiterPanel` — **four** paths, not two | `applied_date` stops being stamped |

The two raw-SQL sites are why labels cannot be what `jobs.status` stores. Both
interpolate nothing and match `status = 'New'` literally, and neither is
reachable from `/settings`; a rename that rewrote rows would leave these two
queries matching a status no row holds any more, silently disabling
stale-posting closure with no error anywhere. `db/schema.sql:14`'s column
default is a third site with the same property.

**`Offer` is no longer on this list.** Revision 2 protected it because
`RolesTable` hardcodes an Offer count tile. That is circular — a status made
undeletable because the UI hardcoded a tile for it. Revision 3 makes the tile row
config-driven, and `Offer` becomes an ordinary deletable status.

`SYSTEM_STATUS_KEYS` is therefore exactly **three**: `New`, `Posting Closed`,
`Applied`. Revision 2 said "all five system rows" above a four-row table; the set
is now enumerated and its size stated once.

`ACTIVE_STATUSES` / `TERMINAL_STATUSES` are not cosmetic groupings:

- `app/actions/link-health.ts:79` skips terminal roles, so the terminal set
  decides **which roles cost a liveness check**.
- `components/RolesTable.tsx:228` — the default `"Open"` filter hides terminal
  rows, so the terminal set decides **what you see on load**.

## Storage is already free-form

`db/schema.sql:14` is `status text not null default 'New'` — no CHECK, no enum.
`Job.status` (`lib/types.ts:94`) is already `JobStatus | string`.

Because built-in keys are exactly today's stored strings, **no data migration is
required for any row holding one of the shipped thirteen** — which was every row
as of 2026-08-15. That is a claim about data, not about code, so it expires: the
re-run in §Problem is what confirms it still holds. A row holding anything else
(a hand-edit, a value from the previous owner's era) resolves to no config entry
and must render through the unknown-key path rather than being rewritten.

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

### The tile row becomes config-driven — DECIDED 2026-08-17: two tiles

`RolesTable.tsx:186-189` counts into four hardcoded buckets and `:213-216` renders
four tiles with hardcoded labels, comparing status by **string literal**:

```ts
if (j.status === "New") c.New++;
else if (ACTIVE_STATUSES.includes(...)) c.Active++;
else if (j.status === "Offer") c.Offer++;
```

Rename `New` to `Fresh` and the row above the table still reads "New", counting
on a literal the user can no longer see. Revision 2 never touched this, so rename
would have shipped visibly half-done.

**Decided:** two tiles — **Open** (bucket `active`) and **Out** (bucket
`terminal`) — plus the per-status chip row that already exists at
`RolesTable.tsx:554` and is config-driven by construction. Every job lands in
exactly one tile, so the sum invariant is true by definition rather than by test,
and the `Other` chip, the hardcoded literals, and the branch-order hazard all
disappear together.

**This changes what you see:** New/Active/Offer/Out becomes Open/Out. The New and
Offer counts are not lost — both remain in the per-status chip row, which is
where a count that follows a rename belongs. The rejected alternative was a
`pinned: boolean` on `JobStatusDef` keeping four tiles; it was declined because it
reintroduces ordering rules, a "what happens when a pinned status is deleted"
case, and the sum-invariant test that two tiles make unnecessary.

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
  `DEFAULT_STATUSES`, `resolveStatuses`, `slugify`, `labelFor`,
  `activeKeys`, `terminalKeys`, **`optionsFor`**, **`tileCounts`**,
  **`compareByConfig`**.
- **The read** lives in `lib/settings-store.ts`, which already imports supabase,
  and returns the raw jsonb value. `resolveStatuses` validates it.

The last three exports are new and exist so the tests below can be written in
`environment: "node"` — see Testing.

**`STATUS_STYLES` must NOT move to `lib/`, and revision 3 had it there.**
`tailwind.config.ts:4-7` scans `./app/**` and `./components/**` only — `lib/` is
not a content root. The badge classes are Tailwind 3 arbitrary values
(`bg-[#DBEAFE] text-[#1E40AF]`) that exist in the compiled CSS *solely* because
they appear as literal strings in `components/RolesTable.tsx:22-36`. Move that map
into `lib/job-statuses.ts` and the JIT scanner never sees them: the file compiles,
the types check, `npm run build` is green, and every status badge in the app
renders with no background and no color. Nothing in the test suite would catch it,
because the map's *values* would still be the correct strings.

The map stays under `components/`. Adding `./lib/**` to the content globs is the
alternative and is worse: it makes any string in any lib module a potential class
name and grows the CSS scan surface to serve one constant.

This is also why per-status colors for custom statuses are out of scope (below).
A user-chosen hex could never generate a class no source file contains — it would
need either a safelist of every permitted value or an inline `style` attribute,
and the neutral-grey fallback avoids both.

### Where it is stored

One `app_settings` row under a **standalone `JOB_STATUSES_KEY` constant**, not a
member of `SETTING_KEYS`.

Revision 2 added a fourth shape group, `JSON_SETTING_KEYS`, and consequently had
to edit two green tests. Its stated reason was that `SettingKeysAreFullyClassified`
(`lib/settings-store.ts:56`) rejects an array-of-objects — but that assertion
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
`lib/crawler.ts` is explicit that a row the user moved out of `New` is
theirs and no automated process may touch it; `STALE_POSTING_CANDIDATES_SQL`
(`:430`) and `CRAWL_TITLE_MATCH_SQL` (`lib/removed-titles.ts:69`) both key on
`status = 'New'`. Reassigning the `Not Interested` rows into `New` re-arms
stale-posting closure against them. Reassigning any terminal status into an active
one also re-arms the liveness billing at `app/actions/link-health.ts:79`.

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

**Tenant safety — the ground has shifted since revision 3, and the requirement is
now narrower but not gone.** Multi-tenancy has since landed: `db/migrations/001_tenant_id.sql`
put `tenant_id` on `jobs`, `watchlist`, `app_settings` and `insights_cache`,
`db/migrations/003_rls.sql` added a `tenant_isolation` policy, and the two defects
revision 3 cited as precedent are **fixed** — `applySideEffects`' delete is
`` `delete from ${table} where tenant_id = $1` `` at `app/actions/settings.ts:157`,
and both raw-SQL status reads now carry `tenant_id = $2`.

The requirement on this feature is therefore not "anticipate tenancy" but "match
what the codebase already does". `reassignStatus` and `countJobsByStatus` are raw
SQL, so `QueryBuilder`'s tenant-table registry does not see them; they must pass a
`tenantId` to `rawQuery` explicitly, whose own docstring says that parameter "is
the only thing that puts a policy in front of it". RLS is a second line of defence,
not a substitute — `lib/supabase.ts` documents that an RLS denial returns **zero
rows rather than an error**, so an unscoped `UPDATE` that the policy blocks would
report success having moved nothing.

**Concurrency:** whole-array replace, last-write-wins across tabs. Accepted.

### Hiding

A hidden status leaves the dropdown, **but the currently selected value is always
injected as an option**. `StatusSelect` (`RolesTable.tsx:978-989`) is the row
renderer as well as the editor — a `<select value={v}>` whose `value` matches no
`<option>` renders the *first* option instead, so hiding `Not Interested` would
make every row holding it display something else while the database disagrees.
Same at `RecruiterPanel.tsx:266` and the add form at `RolesTable.tsx:1205`.

**System statuses cannot be hidden.** Revision 2 guarded their *buckets* and left
hiding open, which is worse: `db/schema.sql:14` still defaults to `New`,
`lib/ingest-roles.ts:145` still writes it, and the two form defaults
(`RolesTable.tsx:1038`, `RecruiterPanel.tsx:37`) still seed `"New"` in state. The
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

**A job holding a key that is in no config entry** is a separate case, and
revision 3 left it undefined while asserting (Testing #9) that every job lands in
exactly one tile *for any config* — which that case falsifies. It arises from a
hand-edited row, a legacy value, or a delete whose reassignment partly failed.

Rule: **an unknown key is displayed verbatim, bucketed `active`, and never
rewritten.** `active` rather than `terminal` because the default `"Open"` filter
hides terminal rows — bucketing it the other way would make a row the user can
still see in the database vanish from the table with no indication why. Not
rewritten because `jobs.status` is the only user-authored column in this app and
the app has no backups. `labelFor` returns the raw key, so the row reads as
whatever it actually holds. Testing #9 is restated accordingly: every job lands in
exactly one tile for any config **and any stored status value**.

## Components

| File | Change |
|---|---|
| `lib/job-statuses.ts` | NEW, pure. Exports listed above. **No `STATUS_STYLES`** — see the Tailwind constraint |
| `lib/job-statuses.test.ts` | NEW |
| `lib/types.ts` | `JobStatus` narrows to `SystemStatusKey` (`:1-14`); the three arrays (`:16`, `:32`, `:42`) deleted after `DEFAULT_STATUSES` is derived from them. `Job.status` at `:94` is already `JobStatus \| string` and is unaffected |
| `lib/settings-store.ts` | Standalone `JOB_STATUSES_KEY`; raw read |
| `lib/settings-effects.ts` | Two `[]` entries |
| `lib/settings-view.ts` | `statuses` added to `SettingsView` (`:21`) |
| `app/actions/settings.ts` | `saveJobStatuses`, `countJobsByStatus`, `reassignStatus` — the last two raw SQL with an explicit `tenantId` |
| `app/actions/jobs.ts` | `getJobStatuses()` with an error channel; also drop the now-unused `JobStatus` import at `:7` |
| `components/Settings.tsx` | New editor — see below |
| `components/RolesTable.tsx` | Fetch; tagged filter state (`:59`); two config-driven tiles replacing the counts at `:186-189` and the tiles at `:213-216`; sort by config index; injected option at the three `<select>` sites `:653`, `:986`, `:1205`; keep `STATUS_STYLES` (`:22-36`) here; **delete dead `EMPTY_FORM` at `:1032`**; label in the `handleStatus` banner |
| `components/RecruiterPanel.tsx` | Fetch; injected option (`:266`); form default (`:37`) |
| `components/ui.tsx` | Delete `StatusBadge` + its map. **Re-verified at `e8b6b1b`: zero callers repo-wide**, and its map is stale besides — it lists `Reviewing`, which is not a `JobStatus`, and gives different colors than `RolesTable` for the same names. `SeniorityBadge` and `Stars` are also unimported and go with it |
| `lib/bulk-status.ts` | **No change.** `summarizeBulkStatus(results, status: string)` is already `string`; the label belongs at the two call sites |
| `app/actions/link-health.ts` | Terminal set from config (`:79`) |
| `lib/crawler.ts`, `lib/ingest-roles.ts` | No change — they write system keys |

### `components/Settings.tsx` has no slot for this

Revision 2 said "new 'Pipeline statuses' section" and estimated ~15 files.
`Settings.tsx` is **852 lines** built on a section-keyed model — `Section` union,
`LABELS`, `Draft`, `EMPTY_DRAFT`, `draftFrom`, and `syncSection`'s exhaustive
switch with no `default`, so a new member is a compile error. `Draft` is all
`string`/`boolean`; a `JobStatusDef[]` does not fit it.

The statuses editor is therefore **its own component with its own local state**,
rendered inside `Settings.tsx` but outside the `Draft` machinery, saving through
`saveJobStatuses` directly. And `package.json` has **no drag-and-drop
dependency**, so reorder is up/down buttons — not drag — unless one is added.

### `JobStatus` narrowing is a type break, not a soft loss

Revision 2 framed it as losing exhaustiveness. `RolesTable.tsx` annotates
`JobStatus` at `:59, :187, :189, :213, :215, :229, :231, :233, :276, :330, :534,
:646, :745, :978, :983, :1033, :1042` — including `handleStatus(job, status:
JobStatus)` and `StatusSelect`'s props, both of which must accept arbitrary config
keys afterward. Each needs retyping to `string`. Note `lib/applied-date.ts`
deliberately went the *other* way, typing `status: JobStatus` so a rename is a
compile error, and documenting at `:22-29` that a bare `string` comparison is
exactly how `applied_date` silently stopped being stamped once before. It stays
`SystemStatusKey`-typed, which is correct and unaffected — and it is the reason
keys, not labels, are what `jobs.status` stores.

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
9. `tileCounts` — every job lands in exactly one tile, for any config **and any
   stored status value, including one in no config entry** (which counts as Open).
10. `compareByConfig` orders by config index, not by label or key.
11. **No file under `lib/` contains a Tailwind arbitrary-value class** (`/bg-\[#/`).
    A grep-style guard, in the spirit of the existing SQL string tests: it is the
    only mechanical way to catch the JIT failure above, which is invisible to
    `tsc`, to `npm run build`, and to every value-level assertion.

Dropped as unwritable without a DOM stack, and stated rather than silently
omitted: direct assertions on the three `<select>` render sites, covered
indirectly by test 8.

Two of revision 2's tests were also vacuous and are gone: "no key is in both the
active and terminal sets" cannot be violated when `bucket` is a single field, and
"reordering changes order but no key" tested that array order is array order.

`npm run build && npm test` is the gate.

## Consequences worth accepting

- The compiler's status guard weakens at the 17 annotations listed above.
  `Job.status` is already `JobStatus | string` and
  `updateJob(id, patch: Partial<Job>)` already accepts a typo today, so the loss
  is narrower than revision 1 claimed — but it is a real break, not a soft one.
- **CLAUDE.md's "Status/filter machinery is constant-driven" paragraph becomes
  wrong**, including its "to add a status: extend the union + arrays" instruction.
  That paragraph must be rewritten in the same commit, not afterward — it is the
  instruction a future session will follow.
- The tile row changes shape: New/Active/Offer/Out becomes Open/Out.

## Out of scope

- Per-status colors for custom statuses (neutral grey fallback) — forced by the
  Tailwind JIT constraint above, not merely deferred.
- `PipelineStatus` (`lib/types.ts:50`) — verified **zero** consumers repo-wide.
- Making the two config writes atomic; ordering plus an explicit warning covers it.
- Drag-to-reorder.

## Review corrections (revision 3 → 4)

1. **`STATUS_STYLES` was placed in `lib/job-statuses.ts`, which would have shipped
   every status badge unstyled.** `tailwind.config.ts:4-7` does not scan `lib/`,
   and the badge classes are arbitrary values that exist only where they are
   written literally. Green build, green tests, broken UI. The map stays in
   `components/`; a grep guard test (Testing #11) now pins it.
2. **The tile-row decision is made** — two tiles, Open/Out. Revision 3 could not be
   approved without it. The `pinned: boolean` alternative is recorded as declined.
3. **Every line number was stale again**, by 1–6 lines, two days after revision 3
   asserted they were all re-derived. Re-derived at `e8b6b1b`, and the header now
   says plainly that these numbers rot and must be re-checked rather than trusted.
4. **The tenant-safety section described defects that have since been fixed.**
   Multi-tenancy landed (`db/migrations/001_tenant_id.sql`, `003_rls.sql`);
   `app/actions/settings.ts:157` is tenant-qualified and both raw-SQL status reads
   carry `tenant_id = $2`. The requirement is narrowed to "pass `tenantId` to
   `rawQuery` explicitly", with the reason RLS is not a substitute stated: a
   policy denial returns zero rows, not an error.
5. **The 73-row scale check is stale** and two nightly crawls have run since. It
   is now marked as needing a re-run, with the query, rather than quoted as fact —
   it underpins both the "no data migration" claim and the delete guard's value.
6. **The `JobStatus` annotation list was incomplete** — 11 sites listed, 17 in the
   file. The filter predicates at `:229-233` and the chip handler at `:534` were
   missing.
7. **A job holding a key in no config entry was undefined**, while Testing #9
   asserted every job tiles for *any* config. Now specified: displayed verbatim,
   bucketed active, never rewritten.
8. **`ui.tsx`'s dead map is also wrong**, not just unused: it lists `Reviewing`,
   which is not a `JobStatus`, and disagrees with `RolesTable` on shared names.
   Recorded so the deletion is not mistaken for a lossy simplification.

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
