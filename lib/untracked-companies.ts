import { normalizeCompanyName } from "@/lib/role-key";
import type { RoleMatch } from "@/lib/types";

// Which companies in a role-search result are NOT already on the watchlist,
// deduped case-insensitively. Normalization here must match
// groupRolesByCompany's (lib/group-by-company.ts) exactly: that function
// keys its groups by normalizeCompanyName(company), and RoleSearchPanel
// checks `untracked.has(company)` against the group's (trimmed) display
// name. A prior version of this function trimmed the key used for
// comparison but pushed the UNTRIMMED `m.company` into the result, so a
// company name with stray whitespace matched groupRolesByCompany's trimmed
// group name in neither the tracked-lookup nor the untracked-set membership
// test — its Track button silently never rendered.
//
// Uses normalizeCompanyName (lib/role-key.ts), not a local
// `.toLowerCase()` — task 5's review found this file and
// group-by-company.ts each carrying their own ad hoc case-fold, a third
// company-identity normalizer independently drifting from the canonical one
// (in particular: neither collapsed internal whitespace or U+00A0 the way
// normalizeCompanyName does). Routing both through the same function is
// what task 5's R1 was written to enforce.
export function untrackedCompanyNames(
  matches: RoleMatch[],
  trackedCompanies: string[]
): string[] {
  const tracked = new Set(trackedCompanies.map(normalizeCompanyName));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of matches) {
    const raw = m.company?.trim();
    if (!raw) continue;
    const key = normalizeCompanyName(raw);
    if (tracked.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
  }
  return out;
}
