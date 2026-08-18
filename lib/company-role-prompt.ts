// The per-company role-search prompt, shared by Discover's "Find Roles" button
// (app/actions/roles.ts) and the crawler's search tier (lib/crawler.ts).
//
// It lived in both files as the same template literal, character for character.
// Out here it is one string, and — more importantly — it is PURE, so a test can
// assert that a changed profile value actually reaches the model. Neither
// caller could be tested: both are modules that read the database and call
// Claude, and app/actions/roles.ts is additionally "use server", which forbids
// non-async exports.

import { roleExtractionSchema, titleListForPrompt, type Criteria } from "@/lib/search-criteria";

export function buildCompanyRolePrompt(args: {
  company: string;
  /** The company's careers page, when one is known. Adds a hint sentence. */
  careersUrl: string | null;
  criteria: Criteria;
  /** The field, in PROSE. profile.searchSubject — never the query form. */
  searchSubject: string;
  persona: string;
  buildingConcept: string;
  buildingUpside: string;
}): string {
  const hint = args.careersUrl ? ` Their careers page may be: ${args.careersUrl}.` : "";
  return `Search for open ${args.searchSubject} roles at "${args.company}".${hint} Look for these titles: ${titleListForPrompt(args.criteria)}. Visit each job posting URL if available to extract the full details. IMPORTANT location filter: ${args.criteria.locationRule}

${roleExtractionSchema(args.persona, args.buildingConcept, args.buildingUpside)}

If no qualifying roles are found, return a JSON object: {"roles": [], "message": "explanation"}. Otherwise return ONLY the JSON array.`;
}
