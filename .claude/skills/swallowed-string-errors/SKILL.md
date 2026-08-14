---
name: swallowed-string-errors
description: Use when writing or reading a `{ error?: string }` result in this repo — adding a server action in app/actions/, returning `error: err.message` from a catch, or branching on `if (res.error)` / `if (jobRes.error)` in a component or lib module. Also use when a write appears to succeed but nothing was stored, or a failure shows no message.
---

# Swallowed string errors

## Overview

Actions in this repo return `{ error?: string }`. **An error string can be empty**, and an
empty string is falsy, so `if (res.error)` reads a hard failure as a success.

This is not hypothetical. `pg` rejects with a Node `AggregateError` — whose `.message` is
`""` — whenever every address of a dual-stack host refuses. That is exactly what an unset
or unreachable `DATABASE_URL` produces, so the failure mode is "the database is entirely
unreachable" and the symptom is a clean build with a silently wrong screen.

The full doctrine lives in `lib/write-failure.ts`. Read it before changing any of this.

## The contract

**Detection is presence. Description is substitution. They happen at different layers.**

| You are writing | Do this |
|---|---|
| A transport (`rawQuery`, `readAllSettingsResult` in `lib/supabase.ts`) | Pass the driver's message through **verbatim, empty included**. A transport that invents text makes every presence check untestable. |
| An action wrapping a **database** write | Return `{ error: error.message }` verbatim — the reader substitutes. |
| An action whose failure is **not** the database (Claude, parsing, fetch) | Substitute your own fallback at the catch: `(err instanceof Error ? err.message : "") \|\| "Failed to …"`. `UNDESCRIBED_DB_ERROR` names the database and would be a false sentence here. |
| **Any reader** of a database write result | `describeWriteFailure(error, "<verb phrase>")`, then branch on `!== undefined`. |

The reader idiom, verbatim:

```ts
// describeWriteFailure, not `if (res.error)`. Presence, not truthiness.
const failure = describeWriteFailure(res.error, "save this role");
if (failure !== undefined) {
  setSaving(false);
  setSaveError(failure);   // already a full sentence — do not prefix it
  return;
}
```

`describeWriteFailure` is in `lib/write-failure.ts`, which imports nothing — client
components can import it. `lib/settings-store.ts` re-exports it for server paths.

## Quick reference

- Reading a DB write result → `describeWriteFailure(...)`, branch on `!== undefined`.
- Reading a non-DB result → the source must already guarantee a non-empty message. Fix it
  at the source, not at the call site.
- `if (error)` where `error` is an **object** (`{ message }` from a query) is fine — objects
  are truthy. The hazard is only the `string` shape.
- An optimistic update rolls back **inside the failure branch**. A truthiness check skips
  the rollback, leaving the new value on screen after a write that never landed.

## Common mistakes

Both of these came from agents given this repo and its CLAUDE.md, working carefully:

```ts
// ❌ empty message → no rollback, no message, row still reads "Archived"
const res = await archiveJob(id);
if (res.error) { setJobs(prevJobs); setActionError(res.error); }

// ❌ empty message → "Failed to archive role: " with nothing after the colon
setActionError(`Failed to archive role: ${res.error}`);
```

`describeWriteFailure` returns a complete sentence ("Could not save this role — …").
Prefixing or interpolating it produces doubled text.

## When it does not apply

`scoreFit` returns an `error` field that no caller branches on — every caller checks
`score > 0`. Adding a presence check there changes nothing. The rule is about `error`
fields that **decide control flow**.

## Real-world impact

Eight instances were found in one audit. A dedicated sweep branch fixed six and **missed
four**, including `lib/ingest-roles.ts`, where a failed insert fell through to
`added.push(role)` — the crawl reported roles it never stored, and the next crawl's dedupe
would have skipped them as already seen. Both agents given this task from scratch
reproduced the defect.
