import { normalizeCompanyName } from "./role-key";

// getWatchedCompanyKeys() (app/actions/watchlist.ts) returns a Set of
// normalized company keys, not raw stored names — a company tracked as
// "Clay" must read as watched when Discover's search results spell it
// "clay". Centralizing the membership test here means Discover's initial
// "already watched" filter and its per-row "Watching ✓" badge both compare
// the same way instead of two independently-written .has() checks drifting
// apart (which is exactly how this class of bug shipped the first time).
export function isCompanyWatched(company: string, watchedKeys: Set<string>): boolean {
  return watchedKeys.has(normalizeCompanyName(company));
}
