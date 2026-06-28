"use server";

import { callWithWebSearch, parseJson } from "@/lib/anthropic";
import { supabase } from "@/lib/supabase";
import { addJob, updateJob } from "./jobs";
import { scoreFit } from "./parse-role";
import type { Role, RolesResult, Startup } from "@/lib/types";

const SYSTEM =
  "You are a recruiting researcher specializing in product management roles. Search for open VP of Product, CPO, Head of Product, Director of Product, and Senior PM roles at the given company. Return ONLY valid JSON, no markdown, no preamble.";

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

    const prompt = `Search for open product leadership roles at "${startup.company}".${hint} Look for VP of Product, CPO, Head of Product, Director of Product, and Senior PM positions. Visit each job posting URL if available to extract the full details. Return a JSON array where each object has these exact fields: role_title (string), job_url (string or empty), location (string), seniority (string, one of: "VP/CPO", "Director", "Senior PM", "PM"), salary_range (string, exact salary or range from the job posting — e.g. "$160,000 - $210,000" — or empty string if not listed), description_summary (string, 1-2 sentences about the role), fit_signal (string, 1 sentence on why a VP of Product with B2B SaaS and AI product background might fit). If no roles are found, return a JSON object: {"roles": [], "message": "explanation"}. Otherwise return ONLY the JSON array.`;

    const raw = await callWithWebSearch({
      system: SYSTEM,
      prompt,
      maxTokens: 2000,
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

    // Add each role to the jobs table, then score fit in parallel.
    const companyDescription = `${startup.tagline}. ${startup.traction ?? ""}`.trim();
    await Promise.all(
      roles.map(async (role) => {
        const jobRes = await addJob({
          company: startup.company,
          role_title: role.role_title,
          status: "New",
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
          source: "Discover",
        });

        if (jobRes.job) {
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
