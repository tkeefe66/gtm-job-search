"use server";

import { callWithWebSearch, parseJson } from "@/lib/anthropic";
import { supabase } from "@/lib/supabase";
import { addJob, updateJob } from "./jobs";
import { scoreFit } from "./parse-role";
import { checkJobUrl } from "@/lib/verify-url";
import type { Role, RolesResult, Startup } from "@/lib/types";

const SYSTEM =
  "You are a recruiting researcher specializing in go-to-market and revenue operations roles. Search for open Head/VP/Director of GTM Systems, RevOps, Revenue Operations, Marketing Operations, GTM Strategy, GTM/AI Operations, GTM Engineer, and AI-Ops practitioner-builder roles at the given company. Return ONLY valid JSON, no markdown, no preamble.";

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

    const prompt = `Search for open go-to-market and revenue operations roles at "${startup.company}".${hint} Look for Head/VP/Director of GTM Systems, RevOps, Revenue Operations, Marketing Operations, GTM Strategy, and GTM/AI Operations positions, as well as GTM Engineer and AI-Ops / automation practitioner-builder roles (these can be IC-level). Visit each job posting URL if available to extract the full details. IMPORTANT location filter: only return roles where the role is fully remote OR at least one of the listed locations is in Denver / Colorado (Denver, Boulder, Colorado Springs, Fort Collins, CO). Exclude roles that are only available in other cities with no remote option (San Francisco only, New York only, London only, etc.). If a role lists "Denver, CO • New York, NY" or is remote-friendly, include it. Return a JSON array where each object has these exact fields: role_title (string), job_url (string or empty), location (string, list all locations from the posting), seniority (string, one of: "VP/Head", "Director", "Senior Manager", "Manager/IC"), salary_range (string, exact salary or range from the job posting — e.g. "$160,000 - $210,000" — or empty string if not listed), description_summary (string, 1-2 sentences about the role), fit_signal (string, 1 sentence on why a GTM Systems / RevOps / Marketing Ops leader and AI practitioner-builder might fit), ic_flag (boolean — set to true when the role is an IC / hands-on practitioner role (e.g. GTM Engineer, RevOps or Marketing Ops IC, AI-Ops / automation engineer) that is worth applying to because it centers on building GTM systems and agentic AI workflows, OR because the function is early/nascent at this company and you'd define it from scratch. Set ic_flag to false for standard leadership roles and for narrow IC roles at mature orgs with no systems/AI-building upside). If no qualifying roles are found, return a JSON object: {"roles": [], "message": "explanation"}. Otherwise return ONLY the JSON array.`;

    const raw = await callWithWebSearch({
      system: SYSTEM,
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
