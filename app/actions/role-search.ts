"use server";

import { callWithWebSearch, parseJson } from "@/lib/anthropic";
import { groupRolesByCompany } from "@/lib/group-by-company";
import { ingestRoles } from "@/lib/ingest-roles";
import { shouldUseCachedRoleSearch } from "@/lib/role-search-cache";
import {
  LOCATION_RULE,
  dateContextLine,
  MAX_QUERIES_PER_SEARCH,
  ROLE_SEARCH_SYSTEM,
  pickQueries,
  roleExtractionSchema,
  stackQueries,
  titleQueries,
} from "@/lib/search-criteria";
import { supabase } from "@/lib/supabase";
import type { RoleMatch, RoleSearchFamily } from "@/lib/types";
import { untrackedCompanyNames } from "@/lib/untracked-companies";
import { getWatchedCompanyKeys } from "@/app/actions/watchlist";

export interface RoleSearchResult {
  matches: RoleMatch[];
  untrackedCompanies: string[];
  fetchedAt: string | null;
  error?: string;
}

const FAMILY_INTRO: Record<RoleSearchFamily, string> = {
  title:
    "Search job boards and company careers pages for currently-open roles matching these searches",
  stack:
    "Search job boards and company careers pages for currently-open go-to-market / revenue operations roles that mention these tools. Titles vary — include Business Systems Manager, Growth Systems Lead, Revenue Systems, and similar, not just the obvious RevOps titles. Use these searches",
};

function allQueriesFor(family: RoleSearchFamily): string[] {
  return family === "title" ? titleQueries() : stackQueries();
}

function buildPrompt(family: RoleSearchFamily, queries: string[]): string {
  return `${FAMILY_INTRO[family]}:

${queries.map((q) => `- ${q}`).join("\n")}

Run as many of these searches as you can and combine the results. ${dateContextLine()} Prioritize postings from the last 60 days. ${LOCATION_RULE}

${roleExtractionSchema()}
- company (string, the hiring company name — REQUIRED, never empty)

Return up to 25 roles. Deduplicate identical postings. Return ONLY the JSON array.`;
}

async function readCache(family: RoleSearchFamily) {
  return supabase
    .from("role_searches")
    .select("roles, fetched_at")
    .eq("family", family)
    .eq("search_term", "")
    .order("fetched_at", { ascending: false })
    .limit(1)
    .maybeSingle();
}

async function untrackedFrom(matches: RoleMatch[]): Promise<string[]> {
  // "Tracked" has to mean exactly what it means everywhere else on the
  // Discover tab: a watchlist row with tracking_enabled = true. This used to
  // read `watchlist` directly with no filter, which gave the one tab two
  // definitions — un-watching a company in company mode is a soft-disable
  // (the row survives by design, see setTracking in app/actions/watchlist.ts),
  // so role search would then list that company with no Track button, no
  // "Watching ✓", and no way to re-track it from here.
  //
  // getWatchedCompanyKeys is the single definition. It returns
  // normalizeCompanyName keys rather than raw stored names;
  // untrackedCompanyNames normalizes whatever it is handed, and that
  // normalizer is idempotent, so passing keys is equivalent to passing the
  // raw names and avoids a second read of the same table.
  const watched = await getWatchedCompanyKeys();
  return untrackedCompanyNames(matches, Array.from(watched));
}

export async function getCachedRoleSearch(
  family: RoleSearchFamily
): Promise<RoleSearchResult> {
  const { data, error } = await readCache(family);
  if (error) {
    return { matches: [], untrackedCompanies: [], fetchedAt: null, error: error.message };
  }
  if (!data) return { matches: [], untrackedCompanies: [], fetchedAt: null };

  const matches = (data.roles ?? []) as RoleMatch[];
  return {
    matches,
    untrackedCompanies: await untrackedFrom(matches),
    fetchedAt: data.fetched_at,
  };
}

export async function findRolesByCriteria(
  family: RoleSearchFamily,
  force = false
): Promise<RoleSearchResult> {
  if (!force) {
    const cached = await getCachedRoleSearch(family);
    // Row presence (fetchedAt set), not match count — a genuine zero-result
    // search is still a valid cache hit. See lib/role-search-cache.ts.
    if (shouldUseCachedRoleSearch(cached)) return cached;
  }

  try {
    // Every web search Claude issues is billed separately, so send a capped,
    // proportionally-spread subset rather than the full 39/24-query list.
    const allQueries = allQueriesFor(family);
    const queries = pickQueries(allQueries);
    console.log(
      `findRolesByCriteria(${family}): sending ${queries.length} of ${allQueries.length} queries — ${queries.join(" | ")}`
    );

    const raw = await callWithWebSearch({
      system: ROLE_SEARCH_SYSTEM,
      prompt: buildPrompt(family, queries),
      // Many searches per call; search narration counts against the budget.
      maxTokens: 8000,
      // The prompt's query list is advisory — the model decides how many
      // searches to actually run, and each one is billed. This is the only
      // hard ceiling on that bill (max_uses on the web_search tool block).
      // Same number as the query list so the cap and the offer agree.
      maxSearches: MAX_QUERIES_PER_SEARCH,
    });

    const parsed = parseJson<RoleMatch[]>(raw);
    const matches = (Array.isArray(parsed) ? parsed : []).filter(
      (m) => m.company && m.role_title
    );

    const fetchedAt = new Date().toISOString();
    const { error: cacheError } = await supabase.from("role_searches").upsert(
      { family, search_term: "", roles: matches, fetched_at: fetchedAt },
      { onConflict: "family,search_term" }
    );

    // A discarded error here is the most expensive silence in this file: the
    // searches above are already billed. The first thing that happens on a
    // deploy without `node db/apply-schema.mjs` is that role_searches doesn't
    // exist — the page load errors loudly, but the search button passes
    // force=true, skips the cache read, runs the full billed query set, fails
    // this write, and renders results as if nothing were wrong. Every later
    // click re-bills with nothing connecting the two.
    //
    // Reported, not thrown: the results below were paid for and must still
    // reach the user. The panel keeps them because the result carries a
    // payload (see shouldReplaceRoleView in lib/role-search-cache.ts).
    let cacheWriteError: string | undefined;
    if (cacheError) {
      cacheWriteError =
        `Found ${matches.length} role${matches.length === 1 ? "" : "s"}, but saving them to ` +
        `the role_searches cache failed — ${cacheError.message}. The results below are live ` +
        `and were not saved, so the next search re-runs (and re-bills) every query. If the ` +
        `role_searches table is missing, apply the schema: ` +
        `DATABASE_URL=... node db/apply-schema.mjs`;
      console.error(`findRolesByCriteria(${family}): cache write failed — ${cacheError.message}`);
    }

    // Ingest per company so dedupe, URL verification, and fit scoring run
    // through the same path the crawler uses. Grouping is case-insensitive
    // (see lib/group-by-company.ts) so "Clay" and "clay" in the same
    // response don't produce two ingestRoles calls and two casings of the
    // same company in the jobs table.
    const byCompany = groupRolesByCompany(matches);

    for (const [company, roles] of Array.from(byCompany)) {
      try {
        await ingestRoles({ company, roles, source: "Role Search" });
      } catch (err) {
        console.error(
          `findRolesByCriteria: ingest failed for ${company} — ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    return {
      matches,
      untrackedCompanies: await untrackedFrom(matches),
      fetchedAt,
      error: cacheWriteError,
    };
  } catch (err) {
    console.error("findRolesByCriteria error:", err);
    return {
      matches: [],
      untrackedCompanies: [],
      fetchedAt: null,
      error:
        err instanceof Error
          ? err.message
          : "Failed to search for roles. Check your ANTHROPIC_API_KEY.",
    };
  }
}
