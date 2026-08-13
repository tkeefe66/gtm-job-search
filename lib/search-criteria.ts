// Single source of truth for what counts as a target role and an acceptable
// location. These were duplicated across the prompts in app/actions/roles.ts
// and app/actions/discover.ts; the crawler and role search add two more
// callers, so they live here now.

export const TARGET_TITLES = [
  "Head of GTM Systems",
  "VP of GTM Systems",
  "Director of GTM Systems",
  "Head of Revenue Operations",
  "VP of Revenue Operations",
  "Director of Revenue Operations",
  "RevOps Lead",
  "Head of Marketing Operations",
  "Director of Marketing Operations",
  "Head of GTM Strategy",
  "Director of GTM/AI Operations",
  "GTM Engineer",
  "AI-Ops / automation practitioner-builder",
];

// Tools that identify these roles even when the title is idiosyncratic
// (Business Systems Manager, Growth Systems Lead, and similar).
export const GTM_STACK_TERMS = [
  "Salesforce",
  "HubSpot",
  "Clay",
  "Gong",
  "Outreach",
  "Marketo",
  "Salesloft",
  "Looker",
];

export const LOCATION_RULE =
  "Only include roles that are fully remote OR list at least one location in " +
  "Colorado (Denver, Boulder, Colorado Springs, Fort Collins, CO). Exclude " +
  'roles available only in other cities with no remote option. If a role lists ' +
  '"Denver, CO • New York, NY" or is remote-friendly, include it.';

export const ROLE_SEARCH_SYSTEM =
  "You are a recruiting researcher specializing in go-to-market and revenue " +
  "operations roles. Return ONLY valid JSON, no markdown, no preamble.";

export function titleListForPrompt(): string {
  return TARGET_TITLES.join(", ");
}

export function roleExtractionSchema(): string {
  return [
    "Return a JSON array where each object has these exact fields:",
    "role_title (string)",
    "job_url (string or empty)",
    "location (string, list all locations from the posting)",
    'seniority (string, one of: "VP/Head", "Director", "Senior Manager", "Manager/IC")',
    'salary_range (string, exact salary or range from the posting — e.g. "$160,000 - $210,000" — or empty string if not listed)',
    "description_summary (string, 1-2 sentences about the role)",
    "fit_signal (string, 1 sentence on why a GTM Systems / RevOps / Marketing Ops leader and AI practitioner-builder might fit)",
    "ic_flag (boolean — true when the role is an IC / hands-on practitioner role that centers on building GTM systems and agentic AI workflows, OR the function is early/nascent at this company and you would define it from scratch. False for standard leadership roles and for narrow IC roles at mature orgs with no systems/AI-building upside)",
  ].join("\n- ");
}
