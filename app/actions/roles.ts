"use server";

import { callWithWebSearch, parseJson } from "@/lib/anthropic";
import { supabase } from "@/lib/supabase";
import { ingestRoles } from "@/lib/ingest-roles";
import type { Role, RolesResult, Startup } from "@/lib/types";
import {
  ROLE_SEARCH_SYSTEM,
  loadCriteriaAndScoringInputs,
  roleExtractionSchema,
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
  const { data, error } = await supabase
    .from("discovered_roles")
    .select("company, roles, fetched_at")
    .order("fetched_at", { ascending: false });

  if (error) return { companies: [], error: error.message };
  return {
    companies: (data ?? []) as SavedCompanyRoles[],
  };
}

export async function findAndSaveRoles(
  startup: Startup,
  force = false
): Promise<RolesResult & { error?: string; cached?: boolean }> {
  // Return cached result if available and not forcing a refresh.
  if (!force) {
    const { data } = await supabase
      .from("discovered_roles")
      .select("roles")
      .eq("company", startup.company)
      .maybeSingle();

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

    const prompt = `Search for open go-to-market and revenue operations roles at "${startup.company}".${hint} Look for these titles: ${titleListForPrompt(criteria)}. Visit each job posting URL if available to extract the full details. IMPORTANT location filter: ${criteria.locationRule}

${roleExtractionSchema()}

If no qualifying roles are found, return a JSON object: {"roles": [], "message": "explanation"}. Otherwise return ONLY the JSON array.`;

    const raw = await callWithWebSearch({
      system: ROLE_SEARCH_SYSTEM,
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
    await supabase.from("discovered_roles").upsert(
      {
        company: startup.company,
        roles,
        fetched_at: new Date().toISOString(),
      },
      { onConflict: "company" }
    );

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

    return { roles, message };
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
