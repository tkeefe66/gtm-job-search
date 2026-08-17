"use server";

import { requireActor } from "@/lib/require-actor";
import { withBudget } from "@/lib/metered";
import { resolveTenantId } from "@/lib/tenant";

import { callWithWebSearch, parseJson } from "@/lib/model-call";
import { cacheWriteWarning, countPhrase } from "@/lib/cache-write-warning";
import { supabase } from "@/lib/supabase";
import { UNDESCRIBED_DB_ERROR } from "@/lib/write-failure";
import { ingestRoles } from "@/lib/ingest-roles";
import type { Role, RolesResult, Startup } from "@/lib/types";
import {
  BUILDING_CONCEPT,
  BUILDING_UPSIDE,
  CANDIDATE_PERSONA,
  SEARCH_SUBJECT,
  loadCriteriaAndScoringInputs,
  roleExtractionSchema,
  roleSearchSystem,
  titleListForPrompt,
} from "@/lib/search-criteria";

export interface SavedCompanyRoles {
  company: string;
  roles: Role[];
  fetched_at: string;
}

export async function getAllSavedRoles(): Promise<{
  companies: SavedCompanyRoles[];
  error?: string;
}> {
  const { data, error } = await supabase.forTenant(await resolveTenantId())
    .from("discovered_roles")
    .select("company, roles, fetched_at")
    .order("fetched_at", { ascending: false });

  if (error) return { companies: [], error: error.message };
  return {
    companies: (data ?? []) as SavedCompanyRoles[],
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
export async function findAndSaveRoles(startup: Startup,
  force = false): Promise<RolesResult & { error?: string; cached?: boolean; cacheWarning?: string }> {
  const actor = await requireActor();
  const budget = await withBudget({
    action: "find-roles",
    estimateCents: 25,
    isAdmin: actor.isAdmin,
    fn: () => findAndSaveRolesInner(startup, force),
  });
  // A cap is a REFUSAL, not a failure — shown as its own sentence rather than
  // as "something went wrong".
  if (budget.capped) return { roles: [], error: budget.capped };
  // Presence, not truthiness: an unreachable database reports an empty message.
  if (budget.error !== undefined) return { roles: [], error: budget.error };
  return budget.result!;
}

async function findAndSaveRolesInner(
  startup: Startup,
  force = false
): Promise<RolesResult & { error?: string; cached?: boolean; cacheWarning?: string }> {
  // Session required. Server Actions are RPC endpoints addressed by an ID that
  // ships in the client bundle, so a page-level check does not cover them.
  await requireActor();
  // Return cached result if available and not forcing a refresh.
  if (!force) {
    const { data, error: cacheReadError } = await supabase.forTenant(await resolveTenantId())
      .from("discovered_roles")
      .select("roles")
      .eq("company", startup.company)
      .maybeSingle();

    // Bound and logged rather than dropped. Falling through to the billed
    // search is the right BEHAVIOR — a cache that cannot be read cannot be
    // served — but doing it silently is how an unreachable database turns into
    // an uncapped web search on every single click with nothing in the log to
    // explain the bill. See the maxSearches note below: this path sets no
    // ceiling at all.
    if (cacheReadError) {
      console.error(
        `findAndSaveRoles(${startup.company}): could not read the discovered_roles cache — ` +
          `${cacheReadError.message || UNDESCRIBED_DB_ERROR}. Falling through to a billed search.`
      );
    }

    if (data) {
      return { roles: data.roles as Role[], cached: true };
    }
  }

  try {
    // Loaded once here and reused for the prompt and the ingest below, so a
    // save landing mid-call cannot split one run across two title lists — or
    // across two compensation floors, which ride in fitInputs off this same read.
    const { criteria, fitInputs } = await loadCriteriaAndScoringInputs();
    const hint = startup.careers_url
      ? ` Their careers page may be: ${startup.careers_url}.`
      : "";

    const prompt = `Search for open ${SEARCH_SUBJECT} roles at "${startup.company}".${hint} Look for these titles: ${titleListForPrompt(criteria)}. Visit each job posting URL if available to extract the full details. IMPORTANT location filter: ${criteria.locationRule}

${roleExtractionSchema(CANDIDATE_PERSONA, BUILDING_CONCEPT, BUILDING_UPSIDE)}

If no qualifying roles are found, return a JSON object: {"roles": [], "message": "explanation"}. Otherwise return ONLY the JSON array.`;

    const raw = await callWithWebSearch({
      system: roleSearchSystem(SEARCH_SUBJECT),
      prompt,
      // The role search runs many web_search calls (often 10+); 2000 tokens
      // truncated the response before the JSON was ever emitted (stop_reason
      // max_tokens), so parseJson got prose and returned nothing. 8000 gives
      // the model room to finish its searches AND output the JSON array.
      maxTokens: 8000,
    });

    const parsed = parseJson<Role[] | RolesResult>(raw);
    let roles: Role[] = [];
    let message: string | undefined;

    if (Array.isArray(parsed)) {
      roles = parsed;
    } else if (parsed && typeof parsed === "object" && "roles" in parsed) {
      roles = parsed.roles ?? [];
      message = parsed.message;
    }

    // Persist roles to discovered_roles table.
    //
    // The result was discarded here, which made this the most expensive
    // silence in the app: the web search above is UNCAPPED (no maxSearches),
    // so every repeat click re-bills the full set. A missing table after a
    // deploy without `node db/apply-schema.mjs` produced exactly that, with
    // nothing in the log connecting the two. Same treatment as
    // findRolesByCriteria's cache write.
    const { error: cacheError } = await supabase.forTenant(await resolveTenantId()).from("discovered_roles").upsert(
      {
        company: startup.company,
        roles,
        fetched_at: new Date().toISOString(),
      },
      { onConflict: "tenant_id,company" }
    );

    // Reported on its OWN key, not on `error`. Discover's handleFindRoles
    // treats `error` as "the search failed" and returns early; the roles here
    // were found, ingested and paid for, so folding this into `error` would
    // discard a successful result to report a cache miss.
    const cacheWarning = cacheError
      ? cacheWriteWarning({
          produced: `Found ${countPhrase(roles.length, "role")} at ${startup.company}`,
          table: "discovered_roles",
          error: cacheError.message,
        })
      : undefined;
    if (cacheWarning) console.error(`findAndSaveRoles: ${cacheWarning}`);

    await ingestRoles({
      company: startup.company,
      roles,
      companyContext: {
        tagline: startup.tagline,
        traction: startup.traction,
        careers_url: startup.careers_url,
        category: startup.category,
        raised: startup.raised,
        stage: startup.stage,
      },
      source: "Discover",
      fitInputs,
    });

    return { roles, message, cacheWarning };
  } catch (err) {
    console.error("findAndSaveRoles error:", err);
    return {
      roles: [],
      error:
        err instanceof Error
          ? err.message
          : "Failed to find roles. Check your ANTHROPIC_API_KEY.",
    };
  }
}
