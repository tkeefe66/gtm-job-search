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

// Search-engine queries. Title queries catch roles named the way the user
// expects. Stack queries catch roles with idiosyncratic titles — Business
// Systems Manager, Growth Systems Lead — that title search structurally
// misses. Titles in this function vary wildly; the tooling does not.

export const LOCATION_TERMS = ["Denver", "Colorado", "remote"];

export function titleQueries(): string[] {
  const queries: string[] = [];
  for (const title of TARGET_TITLES) {
    for (const place of LOCATION_TERMS) {
      queries.push(`"${title}" ${place} job opening`);
    }
  }
  return queries;
}

export function stackQueries(): string[] {
  const queries: string[] = [];
  for (const tool of GTM_STACK_TERMS) {
    for (const place of LOCATION_TERMS) {
      queries.push(`"${tool}" revenue operations hiring ${place}`);
    }
  }
  return queries;
}

// Web searches are billed per search, so a call gets a bounded subset of the
// full query enumeration rather than all 39 title / 24 stack queries. Selection
// is a proportional spread rather than a head slice: the query list is
// title-major, so `slice(0, 15)` would cover only the first 5 of 13 titles,
// while striding proportionally covers every title and all three location terms.
export const MAX_QUERIES_PER_SEARCH = 15;

export function pickQueries(queries: string[], cap: number = MAX_QUERIES_PER_SEARCH): string[] {
  if (cap <= 0) return [];
  if (queries.length <= cap) return queries;
  const out: string[] = [];
  for (let i = 0; i < cap; i++) {
    out.push(queries[Math.floor((i * queries.length) / cap)]);
  }
  return out;
}

// The model has no idea what today's date is, so a prompt that only says
// "recent" or "the last 60 days" leaves it to guess a year — and it guesses
// from training bias. Observed in production on 2026-08-13: every one of the
// 14 issued web searches had "2025" appended, biasing the whole result set
// toward year-old postings. Stating the date explicitly, and telling it not to
// invent a year, is the fix. Injected into every date-sensitive search prompt.
export function dateContextLine(now: Date = new Date()): string {
  const today = now.toISOString().slice(0, 10);
  return (
    `Today's date is ${today}. Do not append a year to any search query — ` +
    `the search engine already returns current results, and an invented year ` +
    `biases the results toward stale postings.`
  );
}
