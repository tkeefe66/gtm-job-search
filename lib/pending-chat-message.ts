// Carries one chat message across the restore navigation.
//
// Sending the first message from a saved résumé restores it into the working
// draft and then lands on the tailor screen, which is the only screen that can
// render a LIVE document. The message has to survive that one hop.
//
// sessionStorage, not a query parameter: this is the user's own prose, and
// putting personal text in a URL leaks it into history, referrers and logs.
//
// The storage object is a PARAMETER rather than a global read, so the contract
// is executable — vitest runs in node, where sessionStorage does not exist, and
// the two things that actually matter here (a take clears, and a stash is keyed
// per job) are exactly what a fake can prove.

/** The subset of Storage this module uses. Anything Storage-shaped works. */
export interface MessageStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function keyFor(jobId: string): string {
  return "pending-chat-message:" + jobId;
}

/**
 * Every access is wrapped: Safari in private mode throws on setItem, and a
 * browser set to block site data throws on read. A failed hand-off costs the
 * user one retyped sentence; a thrown exception would break the click that was
 * supposed to restore their résumé.
 */
export function stashPendingMessage(store: MessageStore, jobId: string, text: string): void {
  const trimmed = text.trim();
  // A blank stash would make the tailor screen fire an empty turn on mount.
  if (trimmed === "") return;
  try {
    store.setItem(keyFor(jobId), trimmed);
  } catch {
    // Nothing to recover: the caller navigates either way, and the user retypes.
  }
}

/**
 * Read-and-CLEAR. The tailor screen sends whatever this returns on mount, so a
 * message that survived the read would re-send on every reload — each one a
 * billed model call that edits the document again.
 */
export function takePendingMessage(store: MessageStore, jobId: string): string | null {
  try {
    const found = store.getItem(keyFor(jobId));
    if (found === null || found === "") return null;
    store.removeItem(keyFor(jobId));
    return found;
  } catch {
    return null;
  }
}
