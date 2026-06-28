"use server";

import { callWithWebSearch, parseJson } from "@/lib/anthropic";
import { supabase } from "@/lib/supabase";
import { addJob } from "./jobs";
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
  startup: Startup
): Promise<RolesResult & { error?: string }> {
  try {
    const hint = startup.careers_url
      ? ` Their careers page may be: ${startup.careers_url}.`
      : "";

    const prompt = `Search for open product leadership roles at "${startup.company}".${hint} Look for VP of Product, CPO, Head of Product, Director of Product, and Senior PM positions. Return a JSON array where each object has these exact fields: role_title (string), job_url (string or empty), location (string), seniority (string, one of: "VP/CPO", "Director", "Senior PM", "PM"), description_summary (string, 1-2 sentences), fit_signal (string, 1 sentence on why a VP of Product with B2B SaaS and AI product background might fit). If no roles are found, return a JSON object: {"roles": [], "message": "explanation"}. Otherwise return ONLY the JSON array.`;

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

    // Add each role to the jobs table with status "New".
    for (const role of roles) {
      await addJob({
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
        fit_summary: role.fit_signal || null,
        source: "Discover",
      });
    }

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
