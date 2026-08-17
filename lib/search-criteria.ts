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

import type { FitInputs } from "@/lib/fit-inputs";
import {
  DEFAULT_WEAK_FIT_TAIL,
  DEFAULT_MODERATE_TAIL,
  DEFAULT_STRONG_TAIL,
} from "@/lib/fit-prompt";
import {
  ceilingFrom,
  compFloorFrom,
  mergeSettings,
  readAllSettings,
  type SettingRow,
} from "@/lib/settings-store";
import type { RoleSearchFamily } from "@/lib/types";

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
    // Unqualified, this field came back as whatever the search engine ranked
    // first, which is usually a reseller. Nearly half the pipeline ended up on
    // ZipRecruiter/BuiltIn/Lensa links, and those outlive the posting they
    // copy — the employer's own board 404s honestly when a req closes, so a
    // direct link is both more useful and more checkable.
    "job_url (string or empty — the EMPLOYER's own application URL, e.g. their " +
      "Greenhouse/Ashby/Lever/Workday board or their own careers site. Use a job " +
      "aggregator link (LinkedIn, Indeed, ZipRecruiter, Built In, Glassdoor, Lensa) " +
      "ONLY when no direct posting exists)",
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

export type QueryPlan = {
  /** The subset actually offered to the model in the prompt. */
  queries: string[];
  /** `max_uses` on the web_search tool block — the hard billing ceiling. */
  maxSearches: number;
  /** Human-readable "why these" for the log line. */
  reason: string;
};

/**
 * Turns the full query enumeration plus the user's optional ceiling into the
 * two numbers the search call needs. Extracted from findRolesByCriteria (which
 * is unreachable from a test — it reads the database and calls Claude) so the
 * precedence rule below is pinned by lib/search-criteria.test.ts.
 *
 * A stored ceiling of 0 or a negative — a bad hand-write, or a settings form
 * that lets an empty field through as 0 — is treated as "no ceiling set", not
 * as "run zero searches". The two decisions must agree: a naive
 * `ceiling ? pickQueries(...) : all` is *falsy* at 0 and sends the full list,
 * while a naive `ceiling ?? all.length * MULT` is *not nullish* at 0 and caps
 * max_uses at 0 — handing the model 39 queries and forbidding it from running
 * any of them, which reads as "the search found nothing" rather than as an
 * error. Normalizing once, here, is what keeps them from disagreeing.
 */
export function planQueries(
  allQueries: string[],
  ceiling: number | null
): QueryPlan {
  const ignored = ceiling !== null && ceiling <= 0;
  if (ignored) {
    // A stored ceiling that cannot be honored must say so. Reporting it as
    // "no ceiling set" would make the diagnostic lie about the single input
    // it exists to explain — the user set a value, and the run ignored it.
    console.warn(
      `search-criteria: ignoring a stored search ceiling of ${ceiling} — a ceiling ` +
        `must be at least 1. Running with no ceiling. Set a positive value on the ` +
        `Settings page, or clear the field to run uncapped on purpose.`
    );
  }
  const cap = ignored || ceiling === null ? null : ceiling;
  const queries = cap === null ? allQueries : pickQueries(allQueries, cap);
  // Floored at 1: max_uses: 0 is a request the API would reject outright, and
  // an empty criteria list (every title deleted) would otherwise produce it.
  const maxSearches = Math.max(1, cap ?? allQueries.length * MAX_QUERY_MULTIPLIER);
  return {
    queries,
    maxSearches,
    reason: ignored
      ? `stored ceiling ${ceiling} ignored (must be >= 1), max_uses ${maxSearches}`
      : cap === null
        ? `no ceiling set, max_uses ${maxSearches}`
        : `ceiling ${cap}, max_uses ${maxSearches}`,
  };
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

/**
 * Everything a role search needs from settings, off ONE read of app_settings.
 *
 * Not `loadCriteria()` followed by `readCeiling()`: that is two round trips,
 * and a save landing between them would run the search with one version's
 * title list and another version's ceiling. Same consistency rule the crawl
 * batch gets from RunContext.
 */
export async function loadSearchInputs(): Promise<{
  criteria: Criteria;
  ceiling: number | null;
  fitInputs: FitInputs;
}> {
  const rows = await readAllSettings();
  const criteria = mergeSettings(DEFAULT_CRITERIA, rows);
  // fitInputs comes off the SAME rows: the search ingests what it finds, and
  // scoring a role against one snapshot's fit brain and another's floor is the
  // split this function exists to prevent.
  return { criteria, ceiling: ceilingFrom(rows), fitInputs: scoringInputsFrom(criteria, rows) };
}

/**
 * Why a search cannot run at all, or null when it can.
 *
 * With every title (or every location) deleted the enumeration is empty, and
 * the search below would still build a prompt with an empty bullet list, spend
 * a Claude call, and return nothing — indistinguishable from "the market has
 * no matching roles". Pure and exported so the guard is testable;
 * findRolesByCriteria itself reads the database and calls the model.
 */
export function emptySearchReason(
  family: RoleSearchFamily,
  criteria: Criteria
): string | null {
  const missing: string[] = [];
  if (family === "title" && criteria.titles.length === 0) missing.push("target titles");
  if (family === "stack" && criteria.stackTerms.length === 0) missing.push("stack terms");
  if (criteria.locations.length === 0) missing.push("location terms");
  if (missing.length === 0) return null;
  return (
    `Cannot run the ${family} search: your ${missing.join(" and ")} list is empty, ` +
    `so there are no queries to send. Add at least one entry on the Settings page, ` +
    `or reset that list to its default.`
  );
}

/**
 * The fit-scoring inputs, resolved the same way `loadCriteria` resolves the
 * search criteria. Lives here rather than in lib/settings-store.ts because the
 * shipped default it falls back to (`DEFAULT_FIT_BRAIN`, via DEFAULT_CRITERIA)
 * lives here, and settings-store must not import this file — search-criteria
 * already imports settings-store.
 *
 * Callers that already hold a `Criteria` AND the rows it came from should call
 * `scoringInputsFrom` instead: this one costs a second settings read.
 */
export async function loadScoringInputs(): Promise<FitInputs> {
  const rows = await readAllSettings();
  return scoringInputsFrom(mergeSettings(DEFAULT_CRITERIA, rows), rows);
}

/**
 * The scoring inputs implied by ONE snapshot of app_settings.
 *
 * Takes the already-merged criteria plus the rows they were merged from, so a
 * caller that needed the criteria anyway derives the fit inputs from the same
 * read rather than taking a second one. `compFloor` is NOT a `Criteria` field
 * — it is a scalar setting like the search ceiling — which is why the rows
 * have to come along.
 *
 * Pure, so the pairing is testable: the whole failure mode here is reading the
 * fit brain from one snapshot and the floor from another, which no integration
 * test would catch and no log line would mention.
 */
export function scoringInputsFrom(criteria: Criteria, rows: SettingRow[]): FitInputs {
  return {
    fitBrain: criteria.fitBrain,
    compFloor: compFloorFrom(rows),
    weakFitTail: DEFAULT_WEAK_FIT_TAIL,
    moderateTail: DEFAULT_MODERATE_TAIL,
    strongTail: DEFAULT_STRONG_TAIL,
  };
}

/**
 * Criteria AND fit inputs off one settings read, for the two paths that need
 * both and hold no rows of their own: the crawl run context (lib/crawler.ts)
 * and Discover's per-company role fetch (app/actions/roles.ts). The keyword
 * role search gets the same pair out of `loadSearchInputs`, which also needs
 * the ceiling.
 *
 * Not `loadCriteria()` followed by `loadScoringInputs()`, for the reason
 * loadSearchInputs gives — that is two round trips, and a save landing between
 * them runs one crawl against one version's title list and another version's
 * compensation floor.
 */
export async function loadCriteriaAndScoringInputs(): Promise<{
  criteria: Criteria;
  fitInputs: FitInputs;
}> {
  const rows = await readAllSettings();
  const criteria = mergeSettings(DEFAULT_CRITERIA, rows);
  return { criteria, fitInputs: scoringInputsFrom(criteria, rows) };
}
