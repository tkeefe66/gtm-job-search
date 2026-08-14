// The empty-message doctrine, in a module with NO imports.
//
// Both halves used to live in lib/settings-store.ts, which imports `pg` via
// lib/supabase.ts. That put them permanently out of reach of every `"use
// client"` component — the reason lib/rescore-progress.ts carries a hand-copied
// twin (UNDESCRIBED_RESCORE_ERROR) and explains in its doc comment that it
// exists only because the original "cannot be imported here without dragging
// `pg` into the browser bundle". Client components that write to the database
// through a server action need the SAME cure the server paths use, so the cure
// moved here and settings-store re-exports it. Nothing about the doctrine
// changed; only where it lives did.
//
// This file must stay import-free. An import of anything that transitively
// reaches lib/supabase.ts re-breaks every client caller.

/**
 * Stands in for a driver error that arrived with nothing to say.
 *
 * WHY this happens, established by probing `pg` directly rather than inferred:
 * the empty message is Node's `AggregateError`, which is what the driver
 * rejects with when a host resolves to MORE THAN ONE address and every
 * connection attempt fails. `AggregateError.message` is the empty string; the
 * real messages hang off `.errors[]` (see aggregateCauses below). With
 * DATABASE_URL unset, pg defaults to localhost, which resolves to both ::1 and
 * 127.0.0.1 — hence the classic no-DATABASE_URL case — but ANY dual-stack host
 * whose every address refuses produces the same empty string.
 *
 * The consequence that matters for copy: an empty message is always a
 * CONNECTION-level failure, never a statement-level one. A SQL error from a
 * connected server (missing table, constraint violation, type mismatch) always
 * carries text. So a user seeing this stand-in has a database that is entirely
 * unreachable — every query in the process is failing together — not one write
 * that went wrong. The wording below says exactly that and must keep saying it.
 *
 * An empty string is falsy, so every `if (error)` downstream reads a hard
 * failure as success. The fix has two halves and they live in different places
 * on purpose. DETECTION is presence: branch on `error !== undefined`, never on
 * truthiness. DESCRIPTION is this constant, substituted only where the message
 * is about to be shown or logged. Transport layers (rawQuery, readAllSettingsResult)
 * keep the driver's message VERBATIM, empty one included, because a transport
 * that invents text makes the presence check untestable — and the presence
 * check is the half that actually matters.
 */
export const UNDESCRIBED_DB_ERROR =
  "the database driver failed without a message, which means the database is " +
  "unreachable entirely rather than one operation having failed (typically an " +
  "unset or unreachable DATABASE_URL)";

/**
 * Turns a writer's `{ error?: string }` into a sentence for the user, or
 * undefined when the write succeeded.
 *
 * A function rather than an `if` at each call site because BOTH halves of the
 * doctrine above are easy to get wrong and most call sites sit in modules no
 * test in this repo can reach (`"use server"` actions, React components).
 *
 *  - DETECTION is presence (`=== undefined`), never truthiness. That exact
 *    defect shipped in `readAllSettings` and produced a clean build, a
 *    permanently wrong page, and zero log output.
 *  - DESCRIPTION substitutes the stand-in only where the text is shown, so a
 *    message-less failure does not render a sentence trailing off after a dash.
 *
 * `what` completes "Could not ___" and is quoted verbatim.
 */
export function describeWriteFailure(
  error: string | undefined,
  what: string
): string | undefined {
  if (error === undefined) return undefined;
  return `Could not ${what} — ${error || UNDESCRIBED_DB_ERROR}`;
}

/**
 * The individual failure messages hidden inside an `AggregateError`, or [] for
 * anything else.
 *
 * This is the ONLY place the real cause of an empty-message failure can be
 * recovered from: `AggregateError.message` is "", but `.errors[]` holds the
 * per-address rejections ("connect ECONNREFUSED ::1:5432", "connect
 * ECONNREFUSED 127.0.0.1:5432"). Everything downstream sees only the empty
 * string, so a diagnostic has to be taken at the catch site or not at all.
 *
 * Deliberately NOT used to fill in `error.message`. Doing that would make the
 * transport invent text — the one thing the doctrine above forbids — and would
 * also erase the empty-message case that every presence check in this codebase
 * is written to survive. It feeds a LOG LINE and nothing else, so behavior is
 * unchanged and the presence checks stay both meaningful and testable.
 *
 * Nested aggregates are flattened one level, which is as deep as Node's
 * happy-eyeballs path ever nests. A cause with an empty message of its own is
 * dropped rather than contributing an empty entry.
 */
export function aggregateCauses(e: unknown): string[] {
  if (!(e instanceof Error)) return [];
  // `errors` is AggregateError's own property; a plain Error simply lacks it.
  const nested = (e as Error & { errors?: unknown }).errors;
  if (!Array.isArray(nested)) return [];

  const out: string[] = [];
  for (const cause of nested) {
    // Recurse first: a non-empty result means this cause was itself an
    // aggregate, so its children are the real messages. An ordinary Error
    // returns [] here and falls through to its own text below.
    const inner = aggregateCauses(cause);
    if (inner.length > 0) {
      out.push(...inner);
      continue;
    }
    const text = cause instanceof Error ? cause.message : String(cause);
    if (text) out.push(text);
  }
  return out;
}
