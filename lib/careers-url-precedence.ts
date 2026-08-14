// Decides whether a newly-guessed careers_url should overwrite what's
// already stored for a company. Used by addToWatchlist (app/actions/watchlist.ts)
// when Discover re-offers a "Watch" action for a company that already has a
// row — most commonly a company the user soft-disabled and is re-watching.
//
// Rules, in order:
//   1. An existing non-empty URL always wins. It may have been typed by hand
//      on the Watchlist page to recover a company whose crawl was broken —
//      Discover's guess must never clobber it. Returns undefined (meaning:
//      omit the column from the write entirely, don't touch it).
//   2. An existing empty/missing URL yields to a non-empty guess — there was
//      nothing to protect, and a resolved URL beats none. Returns the
//      trimmed guess.
//   3. Both empty: stays empty. Returns undefined.
//
// The return value doubles as the reset signal for the caller: whenever this
// returns a defined string, the URL is actually changing, so crawl_method /
// last_crawl_status / last_crawl_error must be reset too (see setCareersUrl's
// comment in app/actions/watchlist.ts for why — a new URL invalidates
// everything the crawler learned about the old one). When it returns
// undefined, nothing changed, so nothing needs resetting.
// Rule 0, ahead of all three above: if we do not KNOW what is stored, we do
// not write.
//
// The caller learns `existing` by reading the watchlist, and that read can
// fail. It used to fail soft to `null` — indistinguishable from "no URL
// stored" — which walked straight into rule 2 and had Discover's guess
// overwrite a hand-typed URL, plus reset crawl_method / last_crawl_status /
// last_crawl_error, on the strength of a read that never happened.
//
// Failing soft is fine; failing soft to a value that licenses an overwrite is
// not. So "unknown" is a state of its own rather than a null, and it is spelled
// as a discriminated union so that `{ known: false }` cannot be confused with
// `{ known: true, url: null }` at a call site — passing a bare string here is
// now a compile error, which is what stops the old shape being reintroduced by
// a plausible-looking edit.
export type StoredCareersUrl =
  | { known: true; url: string | null | undefined }
  | { known: false };

export function resolveCareersUrlWrite(
  existing: StoredCareersUrl,
  guess: string | null | undefined
): string | undefined {
  // Unknown beats everything, including a confident-looking guess.
  if (!existing.known) return undefined;

  const existingTrimmed = (existing.url ?? "").trim();
  if (existingTrimmed) return undefined;

  const guessTrimmed = (guess ?? "").trim();
  return guessTrimmed || undefined;
}
