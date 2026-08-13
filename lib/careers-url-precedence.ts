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
export function resolveCareersUrlWrite(
  existing: string | null | undefined,
  guess: string | null | undefined
): string | undefined {
  const existingTrimmed = (existing ?? "").trim();
  if (existingTrimmed) return undefined;

  const guessTrimmed = (guess ?? "").trim();
  return guessTrimmed || undefined;
}
