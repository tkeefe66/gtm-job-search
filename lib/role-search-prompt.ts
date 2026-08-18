// The keyword role-search prompt (app/actions/role-search.ts), out here for the
// reason lib/fit-prompt.ts is out of app/actions/parse-role.ts: "use server"
// forbids non-async exports, so nothing in that action can be exported pure or
// reached from a test — and this prompt now carries per-tenant text that a test
// has to be able to see.

import { dateContextLine, roleExtractionSchema, type Criteria } from "@/lib/search-criteria";
import type { RoleSearchFamily } from "@/lib/types";

/**
 * The title family's intro.
 *
 * Career-agnostic as written — it names no field and no titles, because the
 * titles are in the query list beneath it — so it stays a constant rather than
 * becoming a profile field. The stack family's intro is the opposite case: it
 * names three GTM job titles after its subject, which is why the whole sentence
 * is per-tenant (profile.stackFamilyIntro).
 */
export const TITLE_FAMILY_INTRO =
  "Search job boards and company careers pages for currently-open roles matching these searches";

export function familyIntro(family: RoleSearchFamily, stackFamilyIntro: string): string {
  return family === "title" ? TITLE_FAMILY_INTRO : stackFamilyIntro;
}

export function buildRoleSearchPrompt(args: {
  family: RoleSearchFamily;
  queries: string[];
  criteria: Criteria;
  stackFamilyIntro: string;
  persona: string;
  buildingConcept: string;
  buildingUpside: string;
  /** Injected so the date line is pinnable. Defaults to now, as it did inline. */
  now?: Date;
}): string {
  return `${familyIntro(args.family, args.stackFamilyIntro)}:

${args.queries.map((q) => `- ${q}`).join("\n")}

Run as many of these searches as you can and combine the results. ${dateContextLine(args.now)} Prioritize postings from the last 60 days. ${args.criteria.locationRule}

${roleExtractionSchema(args.persona, args.buildingConcept, args.buildingUpside)}
- company (string, the hiring company name — REQUIRED, never empty)

Return up to 25 roles. Deduplicate identical postings. Return ONLY the JSON array.`;
}
