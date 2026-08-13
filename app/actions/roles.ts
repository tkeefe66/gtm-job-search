"use server";

import { callWithWebSearch, parseJson } from "@/lib/anthropic";
import { supabase } from "@/lib/supabase";
import { addJob, updateJob } from "./jobs";
import { scoreFit } from "./parse-role";
import { checkJobUrl } from "@/lib/verify-url";
import type { Role, RolesResult, Startup } from "@/lib/types";
import {
  LOCATION_RULE,
  ROLE_SEARCH_SYSTEM,
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
    const hint = startup.careers_url
      ? ` Their careers page may be: ${startup.careers_url}.`
      : "";

    const prompt = `Search for open go-to-market and revenue operations roles at "${startup.company}".${hint} Look for these titles: ${titleListForPrompt()}. Visit each job posting URL if available to extract the full details. IMPORTANT location filter: ${LOCATION_RULE}

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

    // Verify job URLs are still live before saving/scoring.
    const urlStatuses = await Promise.all(
      roles.map((role) => checkJobUrl(role.job_url))
    );
    const liveCount = urlStatuses.filter((s) => s === "live").length;
    const deadCount = urlStatuses.filter((s) => s === "dead").length;
    const unknownCount = urlStatuses.filter((s) => s === "unknown").length;
    console.log(
      `URL check: ${liveCount} live, ${deadCount} dead, ${unknownCount} unknown for ${startup.company}`
    );

    // Add each role to the jobs table, then score fit in parallel.
    const companyDescription = `${startup.tagline}. ${startup.traction ?? ""}`.trim();
    await Promise.all(
      roles.map(async (role, i) => {
        const urlStatus = urlStatuses[i];
        const isDead = urlStatus === "dead";

        const jobRes = await addJob({
          company: startup.company,
          role_title: role.role_title,
          status: isDead ? "Posting Closed" : "New",
          seniority: role.seniority || null,
          location: role.location || null,
          job_url: role.job_url || null,
          careers_url: startup.careers_url || null,
          category: startup.category || null,
          raised: startup.raised || null,
          stage: startup.stage || null,
          traction: startup.traction || null,
          salary_range: role.salary_range || null,
          fit_summary: role.fit_signal || null,
          ic_flag: role.ic_flag ?? false,
          source: "Discover",
        });

        if (jobRes.job && !isDead) {
          const scored = await scoreFit({
            company: startup.company,
            role_title: role.role_title,
            company_description: companyDescription,
            key_skills: role.description_summary,
            fit_summary: role.fit_signal,
            department: "",
            location: role.location,
          });
          if (scored.score > 0) {
            await updateJob(jobRes.job.id, {
              fit_score: scored.score,
              fit_summary: scored.rationale || role.fit_signal || null,
            });
          }
        }
      })
    );

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
