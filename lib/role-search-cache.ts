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

// Whether a RoleSearchResult should replace what the panel is currently
// showing. A failed cache read or a failed search returns
// `{ matches: [], fetchedAt: null, error }` — applying that wipes results the
// database still holds, and the only way back is toggling the family and
// back, which nothing tells the user. So an errored result with no payload
// leaves the view alone (the error banner still renders above it).
//
// An errored result that DOES carry a payload must still replace the view:
// that is the cache-write failure path in findRolesByCriteria, where the
// billed search succeeded and the user has to see the roles they just paid
// for alongside the warning that they were not saved.
//
// Row presence (fetchedAt) is the payload signal, not matches.length — the
// same reasoning as shouldUseCachedRoleSearch above. A clean result with no
// cached row yet (no error, fetchedAt null) must still replace the view, or
// switching families would show the previous family's roles.
export interface RoleSearchResultLike {
  fetchedAt: string | null;
  error?: string;
}

export function shouldReplaceRoleView(res: RoleSearchResultLike): boolean {
  // PRESENCE, not truthiness. `!res.error` read a connection-level failure —
  // whose message is the empty string — as "no error at all", so the one input
  // this function exists to reject (an errored result with no payload) took
  // the success branch and wiped the roles on screen. The doc comment above
  // said the opposite of what the code did.
  return res.error === undefined || res.fetchedAt !== null;
}
