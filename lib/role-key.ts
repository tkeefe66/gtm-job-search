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
