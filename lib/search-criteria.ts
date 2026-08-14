// Single source of truth for what counts as a target role and an acceptable
// location. These were duplicated across the prompts in app/actions/roles.ts
// and app/actions/discover.ts; the crawler and role search add two more
// callers, so they live here now.
//
// The DEFAULT_* constants below are the fresh-install seed and runtime
// fallback. The actual criteria the app runs on is a `Criteria` object —
// shipped defaults overlaid with any user-saved overrides — produced by
// `loadCriteria()` at the bottom of this file. The pure query-building
// functions take that object as a parameter so they stay testable without a
// database.

import { mergeSettings, readAllSettings } from "@/lib/settings-store";

export const DEFAULT_TARGET_TITLES = [
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
export const DEFAULT_GTM_STACK_TERMS = [
  "Salesforce",
  "HubSpot",
  "Clay",
  "Gong",
  "Outreach",
  "Marketo",
  "Salesloft",
  "Looker",
];

export const DEFAULT_LOCATION_RULE =
  "Only include roles that are fully remote OR list at least one location in " +
  "Colorado (Denver, Boulder, Colorado Springs, Fort Collins, CO). Exclude " +
  'roles available only in other cities with no remote option. If a role lists ' +
  '"Denver, CO • New York, NY" or is remote-friendly, include it.';

export const ROLE_SEARCH_SYSTEM =
  "You are a recruiting researcher specializing in go-to-market and revenue " +
  "operations roles. Return ONLY valid JSON, no markdown, no preamble.";

export const DEFAULT_FIT_BRAIN = `
Tom Keefe is a GTM Systems / RevOps / Marketing Operations leader and practitioner-builder with this background:
- 13+ years architecting B2B revenue engines; 6+ years inside the ABM/ABX product category (Demandbase, Engagio)
- Current: Director of GTM Experts at Demandbase — leads a team that architects GTM systems and AI workflows for enterprise customers (BlackRock, Boeing, Microsoft, SAP Concur, Snowflake); influenced $43M+ in won revenue and $96M+ in pipeline
- Deep expertise: the quantitative spine of GTM — pipeline waterfall modeling, ICP analysis, capacity planning, attribution, predictive account scoring, forecasting; QBR / board narrative work with CMOs, CROs, and RevOps leaders
- Tooling: Marketo, Salesforce, Tableau, Bizible, LeanData, Workato, Outreach; led Pardot→Marketo migrations and multiple acquisition data migrations
- AI builder: ships AI-first products and agentic workflows hands-on ("vibe-codes" working prototypes) — built a live AI product demo for a flagship event, a multi-agent B2B news intelligence agent, and other agentic apps
- Strong: GTM systems architecture, marketing/revenue operations leadership, AI/agentic GTM workflows, enterprise B2B SaaS, data-driven GTM strategy, executive storytelling, cross-functional leadership (Sales, Marketing, Product, CS, Finance)
- Weaker fit: pure people-management roles with no systems/building, non-B2B or non-SaaS industries, roles with no AI/automation upside, deeply technical software-engineering roles
- Looking for: Head / VP / Director of GTM Systems, RevOps, Revenue Operations, Marketing Operations, GTM Strategy, or GTM/AI Operations — plus GTM Engineer and AI-Ops practitioner-builder roles where hands-on systems + agentic AI work is the point
- Open to high-impact IC / GTM Engineer roles at AI-first or hyper-growth B2B SaaS companies where the building, equity, and learning opportunity outweigh the title
- Based in Denver, CO; targets fully-remote roles and roles in the Denver / Colorado area
`.trim();

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

export const DEFAULT_LOCATION_TERMS = ["Denver", "Colorado", "remote"];

export type Criteria = {
  titles: string[];
  locations: string[];
  stackTerms: string[];
  locationRule: string;
  fitBrain: string;
};

export const DEFAULT_CRITERIA: Criteria = {
  titles: DEFAULT_TARGET_TITLES,
  locations: DEFAULT_LOCATION_TERMS,
  stackTerms: DEFAULT_GTM_STACK_TERMS,
  locationRule: DEFAULT_LOCATION_RULE,
  fitBrain: DEFAULT_FIT_BRAIN,
};

export function titleListForPrompt(criteria: Criteria): string {
  return criteria.titles.join(", ");
}

export function titleQueries(criteria: Criteria): string[] {
  const queries: string[] = [];
  for (const title of criteria.titles) {
    for (const place of criteria.locations) {
      queries.push(`"${title}" ${place} job opening`);
    }
  }
  return queries;
}

export function stackQueries(criteria: Criteria): string[] {
  const queries: string[] = [];
  for (const tool of criteria.stackTerms) {
    for (const place of criteria.locations) {
      queries.push(`"${tool}" revenue operations hiring ${place}`);
    }
  }
  return queries;
}

// The runaway rail, not a coverage ration. Measured cost of an uncapped title
// run is ~$1.13 against ~$0.55 capped — the old fixed cap of 15 rationed
// coverage on the most central titles to save about sixty cents, which is the
// wrong trade for a job search. When the user sets no ceiling, max_uses is
// this multiple of the query count: high enough never to bind in normal use,
// low enough to stop a loop. When the user does set a ceiling, that wins.
export const MAX_QUERY_MULTIPLIER = 2;

// Web searches are billed per search, so a call gets a bounded subset of the
// full query enumeration rather than all 39 title / 24 stack queries. Selection
// is a proportional spread rather than a head slice: the query list is
// title-major, so `slice(0, 15)` would cover only the first 5 of 13 titles,
// while striding proportionally covers every title and all three location terms.
export function pickQueries(queries: string[], cap: number): string[] {
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

/**
 * The criteria the app is actually running on: shipped defaults with any
 * user-saved overrides on top. Never throws — a failed read logs and returns
 * the defaults (see readAllSettings), because the crawler calls this on every
 * run and an empty title list would make it silently find nothing.
 */
export async function loadCriteria(): Promise<Criteria> {
  const rows = await readAllSettings();
  return mergeSettings(DEFAULT_CRITERIA, rows);
}
