import type { RoleMatch } from "@/lib/types";

// Groups role-search matches by company, case-insensitively. Two matches for
// "Clay" and "clay" must land in the same group — ingestRoles dedupes with
// `lower(company) = lower($1)`, and trackCompanyByName reuses an existing
// row's exact casing, so exact-case grouping here would split one company
// into two ingestRoles calls and reintroduce the duplicate-casing rows a
// prior build shipped ("Clay" vs "clay" as separate billed rows).
//
// The displayed/ingested name for each group is the FIRST-SEEN casing,
// matching the behavior already used by untrackedFrom in role-search.ts.
export function groupRolesByCompany(matches: RoleMatch[]): Map<string, RoleMatch[]> {
  const displayNameByKey = new Map<string, string>();
  const groups = new Map<string, RoleMatch[]>();

  for (const m of matches) {
    const raw = m.company?.trim();
    if (!raw) continue;
    const key = raw.toLowerCase();

    let displayName = displayNameByKey.get(key);
    if (!displayName) {
      displayName = raw;
      displayNameByKey.set(key, displayName);
      groups.set(displayName, []);
    }
    groups.get(displayName)!.push(m);
  }

  return groups;
}
