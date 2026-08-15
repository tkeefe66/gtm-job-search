# User-editable job statuses — design

**Status:** revision 2, 2026-08-15. Approved in chat; not yet implemented.
Revision 1 was reviewed against the code and 14 findings came back — every
file:line citation held, but two existing tests failed against the design, one
of the four "load-bearing" statuses rested on dead code, and several UI
consequences were unaddressed. This revision incorporates all of them; the
Review corrections section at the end records what changed and why, so the
reasoning is not lost.

## Problem

The status dropdown on `/roles` ships thirteen values and none of them can be
changed. A user whose process has no "Exec Presentation" step looks at it on
every row forever; a user who wants "Take-home" has nowhere to put it.

The list is a TypeScript union in `lib/types.ts:1-14`, mirrored into three
arrays (`JOB_STATUSES`, `ACTIVE_STATUSES`, `TERMINAL_STATUSES`) that drive the
dropdown, the filter chips, the count buckets, and — less obviously — which
roles the link-health pass re-verifies.

**Scale check, from production on 2026-08-15:** 73 rows, three distinct
statuses in use — `Posting Closed` 29, `New` 23, `Not Interested` 21. Ten of
the thirteen built-ins have never been used. The clutter this feature removes
is real, but the add/rename half is being built ahead of demand. Accepted
deliberately after the numbers were shown.

## What the user asked for

Confirmed in chat, all four: reorder, rename, hide, add, delete. Plus an
editable active/terminal classification, and the load-bearing statuses
renamable but not deletable.

## The constraint that shapes everything: some statuses are load-bearing

These are written or read by code, not merely displayed. Letting the user
delete them breaks a path with no error anywhere.

| Key | Touched at | Consequence if it stops existing |
|---|---|---|
| `New` | Written: `lib/ingest-roles.ts:142`, `RolesTable.tsx:1021,1030`, `RecruiterPanel.tsx:36`. **Read in raw SQL**: `lib/crawler.ts:427` (`STALE_POSTING_CANDIDATES_SQL`), `lib/removed-titles.ts:68` (`CRAWL_TITLE_MATCH_SQL`). **Column default**: `db/schema.sql:14` | Ingest has nowhere to put a role; stale-posting closure stops matching |
| `Posting Closed` | `lib/ingest-roles.ts:142`, `app/actions/link-health.ts:139,163`, `lib/crawler.ts:490` | Link repair and the crawler write a phantom status |
| `Applied` | `lib/applied-date.ts` via `RolesTable.tsx` `handleStatus` / `handleBulkStatus` | `applied_date` stops being stamped |
| `Offer` | `RolesTable.tsx:187,214` — its own count bucket and chip | The Offer chip counts zero forever |

The two SQL literals and the column default are why immutable keys are not
merely convenient: they are unreachable from `/settings` by construction.

`ACTIVE_STATUSES` / `TERMINAL_STATUSES` are not cosmetic groupings:

- `app/actions/link-health.ts:78` skips terminal roles, so the terminal set
  decides **which roles cost a liveness check**.
- `RolesTable.tsx:228` — the default `"Open"` filter hides terminal rows, so
  the terminal set decides **what you see when the page loads**.

## Storage is already free-form

`db/schema.sql:14` is `status text not null default 'New'` — no CHECK
constraint, no enum. `Job.status` (`lib/types.ts:94`) is already
`JobStatus | string`. Confirmed against production: all 73 rows hold one of the
shipped thirteen, so **no data migration is required**.

## Design

### Keys are immutable; labels are presentation

```ts
export type StatusBucket = "active" | "terminal" | "neutral";

export type JobStatusDef = {
  key: string;          // immutable; this is what jobs.status stores
  label: string;        // displayed; freely editable
  bucket: StatusBucket;
  hidden: boolean;      // absent from the dropdown; see "Hiding" below
  system?: SystemStatusKey;
};
```

Built-in keys are exactly today's stored strings. Custom statuses get a slug
key derived from their label at creation, immutable afterward.

**Reserved keys.** `slugify` must reject or suffix collisions with the filter
sentinels and count-bucket keys as well as existing statuses:
`All`, `Open`, `Active`, `Out`, `Other` (`RolesTable.tsx:58`, `:183`). A custom
status keyed `Open` would otherwise shadow the default filter.

**Rejected alternative:** store the label and `UPDATE` all rows on rename. It
cannot rename the system statuses — their literals live in code and in SQL
that `/settings` cannot edit.

### Where it is stored

One `app_settings` row under `jobStatuses`, value = the full `JobStatusDef[]`.
Absent → `DEFAULT_STATUSES`. A saved value replaces the default wholesale, so
deletions need no tombstones.

This does **not** go through `Criteria`/`mergeSettings`, for one structural
reason: `SettingKeysAreFullyClassified` (`lib/settings-store.ts:54-57`) asserts
at compile time that every setting key is in `LIST_`, `TEXT_`, or
`NUMBER_SETTING_KEYS`. An array of objects is none of the three. So:

- add `JSON_SETTING_KEYS` with `jobStatuses` as its first member;
- add a `saveJobStatuses()` action alongside the existing save actions;
- **update `lib/settings-store.test.ts:289`** — `grouped` sums only three
  groups today and its `toEqual(Object.values(SETTING_KEYS))` assertion fails
  the moment a fourth exists. The shape-vs-default test at `:305-315` needs a
  `JSON_SETTING_KEYS` clause too.

`mergeSettings` is not used for this key; `lib/job-statuses.ts` reads the raw
row and validates it itself.

### Side effects on save

`CACHES_TO_CLEAR[jobStatuses] = []` and `AFFECTS_CRAWL` excludes it: statuses
change nothing about what is searched or how roles are scored.

`PATHS_TO_REVALIDATE[jobStatuses] = []`, **not** `["/roles"]`. `/roles` is a
client component that fetches for itself, which is exactly the rule
`lib/settings-effects.test.ts:157-165` pins ("nothing else revalidates
anything — no setting but the floor is rendered"). Revalidating would both
break that test and be a wasted round trip. `RolesTable` picks up new statuses
through its own fetch, below.

### How the config reaches the components

Both consumers read it client-side, in the same fetch they already make. No
server props.

- **`/settings`**: statuses ride inside `SettingsView` (`lib/settings-view.ts:21`)
  alongside `compFloor` and `ceiling`, returned by the existing `getSettings()`.
  `app/settings/page.tsx` is a synchronous server component that renders
  `<Settings />` with no props, and `Settings.tsx` re-reads through
  `getSettings()` after every save — a server-rendered prop would go stale
  immediately and could not be refreshed, since
  `lib/settings-effects.test.ts:170` pins that `/settings` never revalidates.
  Riding in `SettingsView` also keeps the **single snapshot** guarantee:
  `getSettings()` takes one read of `app_settings`, and a separate
  `loadJobStatuses()` call would be a second snapshot a concurrent save can
  split.
- **`/roles`**: a `getJobStatuses()` action called alongside the existing
  `getJobs()` at `RolesTable.tsx:95`.

### Deleting a status that jobs hold

Blocked, with the count shown and a "reassign to…" picker.

**Order matters and is part of the contract:** reassign first
(`UPDATE jobs SET status = <new key> WHERE status = <old key>`), then save the
config with the status removed. In that order a failure between the two steps
is harmless — rows have moved to a key that is still in the list, and the user
can retry. The reverse order can leave rows on a key no longer in the config,
which is precisely the orphan state this design rejects. The two writes are not
atomic and are not made so; the ordering is what makes that acceptable.

### Error contract

Per `.claude/skills/swallowed-string-errors` and CLAUDE.md, all three new
actions return `{ error?: string }` with the driver's message **verbatim,
empty string included**, and every caller branches on presence
(`describeWriteFailure(...) !== undefined`), never truthiness:

- `saveJobStatuses(defs)` — write.
- `reassignStatus(fromKey, toKey)` — write; returns rows affected.
- `countJobsByStatus()` — read. **Must carry an error channel.** A failed count
  that reads as `0` would silently unlock the delete guard, which is the exact
  class of bug the skill exists for. On error the delete button stays disabled
  and the reason is shown.

**Concurrency:** `jobStatuses` is a whole-array replace, so two tabs are
last-write-wins. Accepted for a single-user app; noted so it is a decision
rather than an oversight.

### Hiding

A hidden status is removed from the dropdown's options **but the currently
selected value is always injected as an option**. `StatusSelect`
(`RolesTable.tsx:966-976`) is the row renderer as well as the editor: it is a
`<select value={value}>` over the status list, and a `value` with no matching
`<option>` makes React render the *first* option instead. Without the
injection, hiding `Not Interested` would make all 21 rows holding it silently
display "New" while the database says otherwise. Same at
`RecruiterPanel.tsx:257-262` and the edit panel at `RolesTable.tsx:1186`.
Pinned by a test.

### Buckets, counts, and the filter row

`RolesTable.tsx:183-190` buckets every job into `New | Active | Offer | Out`,
and today all thirteen statuses land somewhere. A `neutral` status lands in
none, so the tiles would stop summing to the row count while `"Open"` still
shows those rows.

Resolution: add an **`Other`** chip that collects `neutral` statuses, rendered
only when non-zero. Invariant test: the chip counts always sum to the total row
count, for any config.

**Filter reconciliation.** `statusFilter` is `useState` in a client component.
If the selected filter names a status that has since been deleted or hidden,
the table shows zero rows with no chip highlighted and no way back. On load and
on config change, a `statusFilter` that no longer resolves resets to `"Open"`.

**Sorting.** `SortKey` includes `"status"` (`RolesTable.tsx:36`) and the
comparator is a generic `(a[sortKey] ?? "").toLowerCase()` (`:254-258`), which
after this change sorts by the invisible key and ignores the user's drag order.
Status sorting must use the config's index.

### System statuses: renamable, not deletable, buckets guarded

Labels and order are freely editable for all five system rows. Buckets are
**not** freely editable, because two moves are silent footguns:

- `New` → `terminal` hides every freshly ingested role behind the default
  `"Open"` filter; the pipeline appears to stop finding roles.
- `Posting Closed` → `active` puts all 29 dead rows back into the link-health
  pass, re-billing a liveness check on every one.

`New` may not be terminal and `Posting Closed` may not be active — enforced in
`resolveStatuses` and pinned by tests. Other system bucket changes warn inline
but are allowed.

### Resolution and failure behavior

`loadJobStatuses()` mirrors `loadCriteria()`: never throws; a failed or
malformed read logs loudly and returns `DEFAULT_STATUSES`. Validation repairs
rather than rejects, in order:

1. Any missing system key is re-appended with its default label and bucket.
2. Duplicate keys — first wins, rest dropped.
3. Unknown `bucket` → `"neutral"`.
4. Empty label → falls back to the key.
5. `New`/`Posting Closed` bucket violations reset to their defaults.

A repaired config is used but not written back.

## Components

| File | Change |
|---|---|
| `lib/job-statuses.ts` | NEW. `DEFAULT_STATUSES`, `JobStatusDef`, `SYSTEM_STATUS_KEYS`, `RESERVED_KEYS`, `resolveStatuses`, `activeKeys`, `terminalKeys`, `labelFor`, `slugify` |
| `lib/job-statuses.test.ts` | NEW. Invariants below |
| `lib/types.ts` | `JobStatus` narrows to the system keys as `SystemStatusKey`; the three arrays deleted |
| `lib/settings-store.ts` | `jobStatuses` key; new `JSON_SETTING_KEYS` group |
| `lib/settings-store.test.ts` | **UPDATE** `grouped` at `:289` and the shape test at `:305-315` |
| `lib/settings-effects.ts` | `CACHES_TO_CLEAR` and `PATHS_TO_REVALIDATE` entries, both `[]` |
| `lib/settings-view.ts` | `statuses` added to `SettingsView` |
| `app/actions/settings.ts` | `saveJobStatuses`, `countJobsByStatus`, `reassignStatus`; `getSettings` returns statuses off its existing single read |
| `app/actions/jobs.ts` | `getJobStatuses()` for the client fetch |
| `components/Settings.tsx` | New "Pipeline statuses" section |
| `components/RolesTable.tsx` | Fetches statuses; drops the constant imports; `Other` chip; filter reconciliation; status sort by config index; injected current option |
| `components/RecruiterPanel.tsx` | Same fetch; injected current option |
| `components/ui.tsx` | **Resolve the divergence** — see below |
| `lib/bulk-status.ts` | Takes the label, not the key: `summarizeBulkStatus` interpolates the status into user copy at `:64-65` and would otherwise print the key after a rename |
| `app/actions/link-health.ts` | Terminal set from config |
| `lib/crawler.ts`, `lib/ingest-roles.ts` | No change — they write and read system keys, stable by construction |

### `components/ui.tsx` is an unresolved merge, not a duplicate

`ui.tsx:5` has six entries; `RolesTable.tsx:21` has thirteen, and they
**disagree** — `New` is blue in one and grey in the other, `Applied` purple vs
blue. `ui.tsx` also carries `Reviewing`, which is not a `JobStatus` at all. Its
only consumer, `StatusBadge`, is imported nowhere (every importer of `./ui`
takes only `Spinner`/`Tag`).

Resolution: **delete `StatusBadge` and its map**; `RolesTable`'s thirteen-entry
map is the surviving source of truth, moved into `lib/job-statuses.ts` beside
the defaults. Custom statuses take the existing neutral grey fallback.

## Testing

`lib/job-statuses.ts` is pure and tests like `lib/discovery-windows.test.ts`.
Written failing-first:

1. Every system key survives an arbitrary saved config, including one that
   omits or deletes it.
2. `New` always resolves — ingest has nowhere else to put a role.
3. No key is in both the active and terminal sets.
4. Duplicate keys collapse to one.
5. A hidden status still resolves a label, and the current value is present in
   the options list even when hidden.
6. A malformed or absent row yields exactly `DEFAULT_STATUSES`.
7. `slugify` never emits a key colliding with an existing key or a reserved
   word.
8. Reordering changes dropdown order and the status sort, but no key.
9. Chip counts sum to the total row count for any config, including one with
   neutral statuses.
10. `New` cannot be terminal; `Posting Closed` cannot be active.

`npm run build && npm test` is the gate, per CLAUDE.md.

## Consequences worth accepting

**The compiler's status guard weakens, though less than revision 1 claimed.**
`Job.status` is already `JobStatus | string` and `updateJob(id, patch:
Partial<Job>)` is how every status write actually happens — so
`updateJob(id, { status: "Aplied" })` compiles *today*, and
`RecruiterPanel.tsx:258` passes `e.target.value` untyped. What is genuinely
lost is exhaustiveness on the narrower set of sites that do use `JobStatus`
directly. The invariant tests replace it for the cases that matter.

**~15 files**, up from the 12 estimated in revision 1.

**CLAUDE.md needs updating.** Its "Status/filter machinery is constant-driven"
paragraph describes the design this replaces, and its "to add a status: extend
the union + arrays" instruction becomes wrong.

## Out of scope

- Per-status colors for custom statuses (neutral grey fallback).
- Reordering the chip row independently of the dropdown.
- `PipelineStatus` (`lib/types.ts:50`), the legacy Tracker funnel vocabulary.
- Making the two config writes atomic; ordering covers it.

## Review corrections (revision 1 → 2)

Recorded so the reasoning survives, not as changelog ceremony.

1. **`Applied` was not load-bearing.** Revision 1 cited
   `app/actions/jobs.ts:43`, inside `updateJobStatus` — which had zero callers,
   so `applied_date` was rendered and never written. Fixed separately in
   `5502b41` before this revision; `Applied` is now genuinely load-bearing via
   `lib/applied-date.ts`, and the table above cites the live path.
2. **Two existing tests failed against revision 1** — the settings-key shape
   partition and the revalidation rule. Both now addressed explicitly.
3. **`Criteria` reasoning corrected.** Revision 1 claimed `SETTING_KEYS` values
   must equal `Criteria` field names. The pinned test is one-directional, and
   `searchCeiling`/`compFloor` are already non-`Criteria` keys. The
   compile-time shape partition alone carries the conclusion.
4. **`/settings` could not have read its own write** through the server prop
   revision 1 described.
5. Added: reserved keys, the hidden-option injection, the `Other` chip, filter
   reconciliation, status sort order, bucket guards on `New`/`Posting Closed`,
   the reassign ordering rule, the error contract, the `ui.tsx` merge, and
   `bulk-status.ts`'s label.
6. **Scale was not stated.** Three of thirteen statuses are in use; that number
   belongs in the spec so the cost is weighed against it.
