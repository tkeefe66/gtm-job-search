// lib/checkpoint-decision.ts
//
// Whether restoring a saved version must first preserve the current draft.
//
// Deliberately NOT in app/actions/restore-saved-version.ts: that file carries
// "use server", which forbids non-async exports — a sync function cannot live
// there — and app/actions/auth-required.test.ts imports every export of every
// file under app/actions/ and asserts it rejects a session-less call, so a
// sync export placed there would fail with a TypeError rather than being
// skipped.
//
// Compares CONTENT, not content_hash. The hash is over sanitized HTML, and two
// documents can share HTML while differing in what produced them: page_margin
// lives outside the captured innerHTML (migration 020's whole reason), so a
// draft differing only in overrides.pageMargin hashes identically. Worse, a row
// written before migration 021 has content null and cannot restore anything —
// suppressing against it destroys the draft's only copy.
export function shouldCheckpoint(
  draft: unknown | null,
  newest: { content: unknown | null } | null
): boolean {
  if (draft === null || draft === undefined) return false;
  if (newest === null) return true;
  if (newest.content === null || newest.content === undefined) return true;
  return JSON.stringify(draft) !== JSON.stringify(newest.content);
}

/**
 * Whether restoring `restoring` over `draft` would change nothing.
 *
 * A SECOND suppression, independent of shouldCheckpoint's, because
 * shouldCheckpoint compares the draft against the newest LIVE saved row and a
 * restore makes the checkpoint it just wrote that newest row. Restore S once:
 * the checkpoint C holds the old draft D, and the draft becomes S. Navigate
 * back and click "Edit this version" on S again — draft (S) still differs from
 * C (D), so shouldCheckpoint says yes, a worthless C2 holding S is written,
 * and the demotion moves C — the ONLY copy of D — from 30 days down to 3.
 * `disabled={isPending}` guards a double-click; it does not guard a back
 * navigation. A restore that would change nothing has nothing to preserve.
 *
 * Same JSON.stringify semantics as shouldCheckpoint, deliberately: the two
 * comparisons must agree about what "the same content" means.
 */
export function restoreWouldChangeNothing(
  draft: unknown | null,
  restoring: unknown | null
): boolean {
  if (draft === null || draft === undefined) return false;
  if (restoring === null || restoring === undefined) return false;
  return JSON.stringify(draft) === JSON.stringify(restoring);
}
