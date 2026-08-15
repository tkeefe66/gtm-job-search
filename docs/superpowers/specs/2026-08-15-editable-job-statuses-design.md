# User-editable job statuses — design

**Status:** approved in chat 2026-08-15, not yet implemented. No code written.

## Problem

The status dropdown on `/roles` ships thirteen values and none of them can be
changed. A user whose process has no "Exec Presentation" step looks at it on
every row forever; a user who wants "Take-home" has nowhere to put it.

The list is a TypeScript union in `lib/types.ts:1-14`, mirrored into three
arrays (`JOB_STATUSES`, `ACTIVE_STATUSES`, `TERMINAL_STATUSES`) that drive the
dropdown, the filter chips, the count buckets, and — less obviously — which
roles the link-health pass re-verifies.

## What the user asked for

Confirmed in chat, all four:

- reorder and rename
- hide statuses they never use
- add their own
- delete built-ins

Plus: the active/terminal classification is editable too, and the four
load-bearing statuses are renamable but not deletable.

## The constraint that shapes everything: four statuses are load-bearing

These are written by code, not merely displayed. Renaming them naively — or
letting the user delete them — breaks a write path with no error anywhere.

| Key | Written at | Consequence if it stops existing |
|---|---|---|
| `New` | `lib/ingest-roles.ts:142`, `components/RolesTable.tsx:1021,1030`, `components/RecruiterPanel.tsx:36` | Every ingested and hand-added role lands on a status not in the list |
| `Posting Closed` | `lib/ingest-roles.ts:142`, `app/actions/link-health.ts:139,163`, `lib/crawler.ts:490` | Link repair and the crawler write a phantom status |
| `Applied` | `app/actions/jobs.ts:43` — stamps `applied_date` as a side effect | Applied-date tracking silently stops |
| `Offer` | `components/RolesTable.tsx:187,214` — its own count bucket and chip | The Offer chip counts zero forever |

`ACTIVE_STATUSES` / `TERMINAL_STATUSES` are not cosmetic groupings either:

- `app/actions/link-health.ts:78` skips terminal roles, so the terminal set
  decides **which roles cost a liveness check**.
- `components/RolesTable.tsx:228` — the default `"Open"` filter hides terminal
  rows, so the terminal set decides **what you see when the page loads**.

## Storage is already free-form

`db/schema.sql:14` is `status text not null default 'New'` — no CHECK
constraint, no enum. `Job.status` (`lib/types.ts:94`) is already
`JobStatus | string`. Nothing at the database or type layer has to be relaxed.

## Design

### Keys are immutable; labels are presentation

```ts
export type StatusBucket = "active" | "terminal" | "neutral";

export type JobStatusDef = {
  key: string;          // immutable; this is what jobs.status stores
  label: string;        // displayed; freely editable
  bucket: StatusBucket;
  hidden: boolean;      // absent from the dropdown, still renders on rows holding it
  system?: SystemStatusKey;  // one of the four above
};
```

**Built-in keys are exactly today's stored strings** (`"New"`,
`"Posting Closed"`, …). That is the whole migration story: every existing row
is already correct, and `lib/crawler.ts:490` can keep writing the literal
`"Posting Closed"` no matter what the user renames it to.

Custom statuses get a slug key derived from their label at creation
(`"Take-home" → "take-home"`), immutable afterward, deduplicated against
existing keys.

**Rejected alternative:** store the label as the status value and `UPDATE` all
job rows on rename. It reads more simply, but it cannot rename the four system
statuses at all — their literals live in code that `/settings` cannot edit —
which contradicts the requirement directly.

### Where it is stored

One `app_settings` row under a new key, `jobStatuses`, whose value is the full
`JobStatusDef[]`. Absent row → `DEFAULT_STATUSES`. A saved value replaces the
default wholesale, so deletions need no tombstones.

**This does NOT go through `Criteria`/`mergeSettings`.** Two reasons, both
structural:

1. `lib/settings-store.ts:7-9` requires every `SETTING_KEYS` value to equal a
   `Criteria` field name. Statuses are not search criteria — they describe the
   pipeline, not what to search for — and forcing them into `Criteria` would
   put them in front of `loadCriteria()`, which the crawler calls on every run.
2. `SettingKeysAreFullyClassified` (`lib/settings-store.ts:54-57`) asserts at
   compile time that every setting key belongs to `LIST_`, `TEXT_`, or
   `NUMBER_SETTING_KEYS`. An array of objects is none of those. Adding
   `jobStatuses` to `SETTING_KEYS` without a fourth shape class is a build
   failure — by design.

**Therefore:** add a fourth shape class, `JSON_SETTING_KEYS`, with
`jobStatuses` as its first member, and a `saveJobStatuses()` action alongside
the existing `saveCriteriaList` / `saveCriteriaText` / `saveCeiling`. The
exhaustiveness assertion then keeps holding. `mergeSettings` is not used;
`lib/job-statuses.ts` reads the raw row and validates it itself.

### Side effects on save

`CACHES_TO_CLEAR[jobStatuses]` is `[]` and `AFFECTS_CRAWL` does **not** include
it: statuses change nothing about what is searched or how roles are scored, so
no cached search is invalidated and `criteria_changed_at` is not stamped.
`PATHS_TO_REVALIDATE` is `["/roles"]`.

### Deleting a status that jobs currently hold

**Blocked, with the count shown and a "reassign to…" picker.** Reassign runs
`UPDATE jobs SET status = <new key> WHERE status = <old key>`, then the delete
proceeds. Allowing the delete and leaving rows on an orphan key was rejected:
it produces a row the table cannot classify into any bucket, which is the
silent-wrongness failure mode this codebase consistently designs against.

Hiding has no such restriction — a hidden status is removed from the dropdown
but rows holding it still render their label and still count in their bucket.

### Resolution and failure behavior

`loadJobStatuses()` mirrors `loadCriteria()`'s contract: it never throws, and a
failed or malformed read logs loudly and returns `DEFAULT_STATUSES`. A settings
page that cannot read the database must not leave `/roles` with an empty
dropdown.

Validation on read repairs rather than rejects, in this order:

1. Any missing system key is re-appended with its default label and bucket.
2. Duplicate keys — first wins, rest dropped.
3. Unknown `bucket` value → `"neutral"`.
4. Empty label → falls back to the key.

A repaired config is used but not written back; the stored row is the user's
and is only rewritten by an explicit save.

## Components

| File | Change |
|---|---|
| `lib/job-statuses.ts` | NEW. `DEFAULT_STATUSES`, `JobStatusDef`, `SYSTEM_STATUS_KEYS`, `resolveStatuses(rows)`, `loadJobStatuses()`, `activeKeys()`, `terminalKeys()`, `labelFor()`, `slugify()` |
| `lib/job-statuses.test.ts` | NEW. Invariants below |
| `lib/types.ts` | `JobStatus` narrows to the four system keys and is renamed `SystemStatusKey`. `JOB_STATUSES` / `ACTIVE_STATUSES` / `TERMINAL_STATUSES` deleted |
| `lib/settings-store.ts` | `jobStatuses` added to `SETTING_KEYS`; new `JSON_SETTING_KEYS` group |
| `lib/settings-effects.ts` | Entries in `CACHES_TO_CLEAR` and `PATHS_TO_REVALIDATE` |
| `app/actions/settings.ts` | `saveJobStatuses()`, `countJobsByStatus()` for the delete guard, `reassignStatus()` |
| `components/Settings.tsx` | New "Pipeline statuses" section |
| `components/RolesTable.tsx` | Takes `statuses: JobStatusDef[]` as a prop; drops the three constant imports; count buckets and chips read `activeKeys()`/`terminalKeys()` |
| `components/RecruiterPanel.tsx` | Same prop |
| `components/ui.tsx` | Shared `STATUS_STYLES` (currently duplicated at `RolesTable.tsx:21` and `ui.tsx:5`) plus key→label lookup |
| `app/roles/page.tsx`, `app/settings/page.tsx` | `loadJobStatuses()` server-side, passed down |
| `app/actions/link-health.ts` | Terminal set from config instead of the constant |
| `lib/crawler.ts`, `lib/ingest-roles.ts`, `app/actions/jobs.ts` | No change — verified they write system keys, which are stable by construction |

## Editor UI

A list under a "Pipeline statuses" heading in `/settings`, one row per status:
drag handle, label field, bucket selector (Active / Terminal / Neither), a hide
toggle, and a delete button. System rows show a lock affordance on delete with
the reason on hover; their label field and bucket stay editable. An "Add
status" button appends a row. A "Reset to defaults" control discards the row
entirely via `deleteSetting`.

Styling follows the existing `/settings` sections — no new visual language.

## Testing

`lib/job-statuses.ts` is pure and tests like `lib/discovery-windows.test.ts`.
Invariants, each written failing-first:

1. Every system key survives an arbitrary saved config — including one that
   omits or deletes it.
2. `New` always resolves, because ingest has nowhere else to put a role.
3. A key is never in both the active and terminal sets.
4. Duplicate keys collapse to one.
5. A hidden status still resolves a label, so rows holding it render.
6. A malformed or absent row yields exactly `DEFAULT_STATUSES`.
7. `slugify` never emits a key colliding with an existing one.
8. Reordering changes dropdown order but no key.

`npm run build && npm test` is the gate, per CLAUDE.md.

## Consequences worth accepting

**The compiler stops catching typo'd statuses.** `JobStatus` today is a union
of thirteen literals, so `status: "Aplied"` fails the build anywhere in the
codebase. After this change only the four system keys are typed; everything
else is `string`. The invariant tests replace that guard for the cases that
matter, but they cannot cover a typo in a UI comparison. This is the real price
of the feature and it is not fully recoverable.

**~12 files.** Materially larger than it looks from `/settings`.

**CLAUDE.md needs updating.** Its "Status/filter machinery is constant-driven"
paragraph describes exactly the design this replaces, including the "to add a
status: extend the union + arrays" instruction, which becomes wrong.

## Out of scope

- Per-status colors. `STATUS_STYLES` keeps its shipped palette; custom
  statuses get the existing neutral grey fallback.
- Reordering the filter chip row independently of the dropdown.
- Any change to `PipelineStatus` (`lib/types.ts:50`), the legacy Tracker funnel
  vocabulary, which is a separate and unused concept.
