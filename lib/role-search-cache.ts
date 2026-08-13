// Whether a cached role search should be served instead of running a new
// (billed) search. The signal is "a cache row exists" — i.e. fetchedAt is
// set — not "the row has matches". A genuine zero-result search is still a
// valid cache hit; treating it as a miss would re-run the full billed query
// set on every subsequent non-forced call for that family, forever. This
// matches the sibling findAndSaveRoles in app/actions/roles.ts, whose cache
// check is row presence (`if (data)`), not result length, and it matches
// CLAUDE.md's caching contract: "API calls only happen on new searches or
// forced refreshes."
export interface CachedRoleSearchLike {
  matches: unknown[];
  fetchedAt: string | null;
}

export function shouldUseCachedRoleSearch(cached: CachedRoleSearchLike): boolean {
  return cached.fetchedAt !== null;
}
