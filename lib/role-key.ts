// Dedupe key for roles. Deliberately ignores job status: a role the user
// already marked Rejected or Not Interested must never be re-added as New by
// a later crawl.

export function normalizeTitle(title: string): string {
  // \s covers U+00A0 (non-breaking space), which scraped careers-page titles
  // are full of — collapsing it is load-bearing for dedupe, so it is tested.
  return title.replace(/\s+/g, " ").trim().toLowerCase();
}

export function normalizeRoleKey(company: string, roleTitle: string): string {
  return `${normalizeTitle(company)}::${normalizeTitle(roleTitle)}`;
}

// Company identity (watchlist dedupe, Discover's "already watched?" checks)
// needs exactly the same normalization as role titles: lowercase, trim,
// collapse whitespace including U+00A0. Aliased rather than reimplemented —
// see the module comment in app/actions/watchlist.ts for why a second,
// subtly different normalizer is the failure mode this is meant to prevent.
export const normalizeCompanyName = normalizeTitle;
