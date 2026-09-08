// Keeps restore markers from stacking in a chat thread.
//
// Every restore appends one assistant turn saying which version is now the
// base, because sendChatTurn feeds the WHOLE thread to the model and a stale
// thread describes a document that is no longer there. But restoring three
// times in a row produced three identical marker turns in a real thread — the
// conversation was pushed off screen and the chat read as broken.
//
// So an identical marker at the END is replaced rather than appended. Only the
// trailing one, and only an exact match: restoring version A and then version B
// is two different facts and the model needs both, and a real assistant turn
// before a restore is conversation the user still needs.

/** Prior messages with a trailing identical marker removed. The caller appends
 *  the new marker to whatever comes back. */
export function withoutRepeatedMarker(prior: unknown[], markerText: string): unknown[] {
  if (prior.length === 0) return prior;
  const last = prior[prior.length - 1];
  // The column is jsonb and nothing validates it on the way in, so a malformed
  // row must read as "not a marker" rather than throwing and failing a restore
  // whose document work has already committed.
  if (typeof last !== "object" || last === null) return prior;
  const row = last as { role?: unknown; text?: unknown };
  if (row.role !== "assistant" || row.text !== markerText) return prior;
  return prior.slice(0, -1);
}
