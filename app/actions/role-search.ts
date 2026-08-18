"use server";

import { requireActor } from "@/lib/require-actor";
import { withBudget } from "@/lib/metered";
import { resolveTenantId } from "@/lib/tenant";

import { callWithWebSearchDetailed } from "@/lib/model-call";
import { arrayUnder, parseOrSalvage } from "@/lib/salvage-call";
import { ROLE_MATCH_FIELDS } from "@/lib/types";
import { cacheWriteWarning, countPhrase } from "@/lib/cache-write-warning";
import { groupRolesByCompany } from "@/lib/group-by-company";
import { ingestRoles } from "@/lib/ingest-roles";
import { buildRoleSearchPrompt } from "@/lib/role-search-prompt";
import { shouldUseCachedRoleSearch } from "@/lib/role-search-cache";
import type { Profile } from "@/lib/profile";
import {
  emptySearchReason,
  loadCriteriaAndScoringInputs,
  loadSearchInputs,
  planQueries,
  roleSearchSystem,
  stackQueries,
  titleQueries,
  type Criteria,
} from "@/lib/search-criteria";
import { supabase } from "@/lib/supabase";
import type { RoleMatch, RoleSearchFamily } from "@/lib/types";
import { untrackedFromWatched } from "@/lib/untracked-companies";
import { getWatchedCompanyKeys } from "@/app/actions/watchlist";

export interface RoleSearchResult {
  matches: RoleMatch[];
  untrackedCompanies: string[];
  fetchedAt: string | null;
  error?: string;
}

function allQueriesFor(
  family: RoleSearchFamily,
  criteria: Criteria,
  profile: Profile
): string[] {
  return family === "title"
    ? titleQueries(criteria)
    : stackQueries(criteria, profile.querySubject);
}

async function readCache(family: RoleSearchFamily) {
  return supabase.forTenant(await resolveTenantId())
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
  // untrackedFromWatched, not untrackedCompanyNames: when the lookup FAILED
  // this must answer "nothing to track" rather than "everything to track".
  // The Track button it feeds performs a write, so offering one for every
  // company on screen — on evidence that does not exist — is how a failed read
  // turns into duplicate watchlist rows. The rule is pinned by a test out in
  // lib/untracked-companies.ts; nothing in this module can be.
  return untrackedFromWatched(matches, {
    keys: Array.from(watched.keys),
    error: watched.error,
  });
}

/**
 * The tenant's `toolsAreWeak` flag, for RoleSearchPanel to hide the "Tools of
 * the trade" family when a tool-name search would return mostly noise for
 * this field — see the doc on `Profile.toolsAreWeak` in lib/profile.ts.
 *
 * Same shape as `getHiringSignal` in app/actions/discover.ts: no explicit
 * requireActor() call needed here because loadCriteriaAndScoringInputs ->
 * readAllSettings -> resolveTenantId() -> requireActor() already refuses an
 * unauthenticated caller, which is what app/actions/auth-required.test.ts
 * verifies for every export in this directory.
 */
export async function getToolsAreWeak(): Promise<{ toolsAreWeak: boolean }> {
  const { profile } = await loadCriteriaAndScoringInputs();
  return { toolsAreWeak: profile.toolsAreWeak };
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

/**
 * Metered. The exported wrapper owns the session check and the budget; the inner
 * function is the original body, untouched.
 *
 * The reservation is a FLOOR, not an estimate — reconciliation corrects it from
 * the searches actually issued, and the budget-derived max_uses bounds how far
 * one call can overshoot first.
 */
export async function findRolesByCriteria(family: RoleSearchFamily,
  force = false): Promise<RoleSearchResult> {
  const actor = await requireActor();
  const budget = await withBudget({
    action: "role-search",
    estimateCents: 25,
    isAdmin: actor.isAdmin,
    fn: () => findRolesByCriteriaInner(family, force),
  });
  // A cap is a REFUSAL, not a failure — shown as its own sentence rather than
  // as "something went wrong".
  if (budget.capped) return { matches: [], untrackedCompanies: [], fetchedAt: null, error: budget.capped };
  // Presence, not truthiness: an unreachable database reports an empty message.
  if (budget.error !== undefined) return { matches: [], untrackedCompanies: [], fetchedAt: null, error: budget.error };
  return budget.result!;
}

async function findRolesByCriteriaInner(
  family: RoleSearchFamily,
  force = false
): Promise<RoleSearchResult> {
  // Session required. Server Actions are RPC endpoints addressed by an ID that
  // ships in the client bundle, so a page-level check does not cover them.
  await requireActor();
  if (!force) {
    const cached = await getCachedRoleSearch(family);
    // Row presence (fetchedAt set), not match count — a genuine zero-result
    // search is still a valid cache hit. See lib/role-search-cache.ts.
    if (shouldUseCachedRoleSearch(cached)) return cached;
  }

  try {
    // ONE read of app_settings, every value derived from it. Loaded before the
    // prompt and reused by the ingest below, so a settings save landing mid-run
    // can neither split the run across two title lists nor pair one version's
    // titles with another version's ceiling — or another version's fit brain
    // and compensation floor, which the ingest scores every found role against.
    const { criteria, ceiling, fitInputs, profile } = await loadSearchInputs();

    // An empty title (or location) list enumerates to zero queries. Without
    // this the run would build a prompt with an empty bullet list, spend a
    // Claude call, and return nothing — reading as "no roles on the market"
    // rather than as a misconfiguration. Checked before anything is billed.
    const emptyReason = emptySearchReason(family, criteria);
    if (emptyReason) {
      console.error(`findRolesByCriteria(${family}): ${emptyReason}`);
      return {
        matches: [],
        untrackedCompanies: [],
        fetchedAt: null,
        error: emptyReason,
      };
    }

    // Every web search Claude issues is billed separately. With no user
    // ceiling set the full enumeration is sent (coverage beats sixty cents,
    // see MAX_QUERY_MULTIPLIER); a ceiling narrows it to a proportional
    // spread. planQueries decides both the offer and the hard cap together.
    const allQueries = allQueriesFor(family, criteria, profile);
    const { queries, maxSearches, reason } = planQueries(allQueries, ceiling);
    console.log(
      `findRolesByCriteria(${family}): sending ${queries.length} of ${allQueries.length} queries ` +
        `(${reason}) — ${queries.join(" | ")}`
    );

    const { text: raw, stopReason } = await callWithWebSearchDetailed({
      system: roleSearchSystem(profile.searchSubject),
      prompt: buildRoleSearchPrompt({
        family,
        queries,
        criteria,
        stackFamilyIntro: profile.stackFamilyIntro,
        persona: profile.candidatePersona,
        buildingConcept: profile.buildingConcept,
        buildingUpside: profile.buildingUpside,
      }),
      // Many searches per call; search narration counts against the budget.
      maxTokens: 8000,
      // The prompt's query list is advisory — the model decides how many
      // searches to actually run, and each one is billed. This is the only
      // hard ceiling on that bill (max_uses on the web_search tool block).
      maxSearches,
    });

    // Recovered rather than thrown: this call is the most expensive in the app
    // (uncapped searches unless the user set a ceiling), so discarding it over
    // a formatting slip throws away everything it just paid for.
    const { items } = await parseOrSalvage<RoleMatch>({
      raw,
      stopReason,
      key: "matches",
      itemNoun: "role match",
      itemFields: ROLE_MATCH_FIELDS,
      label: `findRolesByCriteria(${family})`,
      extract: arrayUnder<RoleMatch>("matches"),
    });
    const matches = items.filter((m) => m.company && m.role_title);

    const fetchedAt = new Date().toISOString();
    const { error: cacheError } = await supabase.forTenant(await resolveTenantId()).from("role_searches").upsert(
      { family, search_term: "", roles: matches, fetched_at: fetchedAt },
      { onConflict: "tenant_id,family,search_term" }
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
    // The message moved to lib/cache-write-warning.ts so the three sibling
    // paths that were discarding this error entirely (roles, discover,
    // insights) say the same thing, and so the schema command cannot drift
    // across four copies. Substitution of an empty driver message happens
    // there, at the point of display.
    let cacheWriteError: string | undefined;
    if (cacheError) {
      cacheWriteError = cacheWriteWarning({
        produced: `Found ${countPhrase(matches.length, "role")}`,
        table: "role_searches",
        error: cacheError.message,
      });
      console.error(`findRolesByCriteria(${family}): ${cacheWriteError}`);
    }

    // Ingest per company so dedupe, URL verification, and fit scoring run
    // through the same path the crawler uses. Grouping is case-insensitive
    // (see lib/group-by-company.ts) so "Clay" and "clay" in the same
    // response don't produce two ingestRoles calls and two casings of the
    // same company in the jobs table.
    const byCompany = groupRolesByCompany(matches);

    for (const [company, roles] of Array.from(byCompany)) {
      try {
        await ingestRoles({
          company,
          roles,
          source: "Role Search",
          fitInputs,
        });
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
