"use server";

import { callWithWebSearch, parseJson } from "@/lib/anthropic";
import { groupRolesByCompany } from "@/lib/group-by-company";
import { ingestRoles } from "@/lib/ingest-roles";
import { shouldUseCachedRoleSearch } from "@/lib/role-search-cache";
import {
  LOCATION_RULE,
  ROLE_SEARCH_SYSTEM,
  pickQueries,
  roleExtractionSchema,
  stackQueries,
  titleQueries,
} from "@/lib/search-criteria";
import { supabase } from "@/lib/supabase";
import type { RoleMatch, RoleSearchFamily } from "@/lib/types";
import { untrackedCompanyNames } from "@/lib/untracked-companies";

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

Run as many of these searches as you can and combine the results. Prioritize postings from the last 60 days. ${LOCATION_RULE}

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
  const { data } = await supabase.from("watchlist").select("company");
  const trackedCompanies = ((data ?? []) as { company: string }[]).map((r) => r.company);
  return untrackedCompanyNames(matches, trackedCompanies);
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
    });

    const parsed = parseJson<RoleMatch[]>(raw);
    const matches = (Array.isArray(parsed) ? parsed : []).filter(
      (m) => m.company && m.role_title
    );

    const fetchedAt = new Date().toISOString();
    await supabase.from("role_searches").upsert(
      { family, search_term: "", roles: matches, fetched_at: fetchedAt },
      { onConflict: "family,search_term" }
    );

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
