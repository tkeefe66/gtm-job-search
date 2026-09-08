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
