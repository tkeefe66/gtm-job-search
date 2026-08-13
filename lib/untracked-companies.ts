import type { RoleMatch } from "@/lib/types";

// Which companies in a role-search result are NOT already on the watchlist,
// deduped case-insensitively. Normalization here (trim, then lowercase) must
// match groupRolesByCompany's (lib/group-by-company.ts) exactly: that
// function keys its groups by trimmed-then-lowercased company, and
// RoleSearchPanel checks `untracked.has(company)` against the group's
// (trimmed) display name. A prior version of this function trimmed the key
// used for comparison but pushed the UNTRIMMED `m.company` into the result,
// so a company name with stray whitespace matched groupRolesByCompany's
// trimmed group name in neither the tracked-lookup nor the untracked-set
// membership test — its Track button silently never rendered.
export function untrackedCompanyNames(
  matches: RoleMatch[],
  trackedCompanies: string[]
): string[] {
  const tracked = new Set(trackedCompanies.map((c) => c.toLowerCase().trim()));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of matches) {
    const raw = m.company?.trim();
    if (!raw) continue;
    const key = raw.toLowerCase();
    if (tracked.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
  }
  return out;
}
