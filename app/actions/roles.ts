"use server";

import { callWithWebSearch, parseJson } from "@/lib/anthropic";
import type { Role, RolesResult } from "@/lib/types";

const SYSTEM =
  "You are a recruiting researcher specializing in product management roles. Search for open VP of Product, CPO, Head of Product, Director of Product, and Senior PM roles at the given company. Return ONLY valid JSON, no markdown, no preamble.";

export async function findRoles(
  company: string,
  careersUrl?: string
): Promise<RolesResult & { error?: string }> {
  try {
    const hint = careersUrl ? ` Their careers page may be: ${careersUrl}.` : "";

    const prompt = `Search for open product leadership roles at "${company}".${hint} Look for VP of Product, CPO, Head of Product, Director of Product, and Senior PM positions. Return a JSON array where each object has these exact fields: role_title (string), job_url (string or empty), location (string), seniority (string, one of: "VP/CPO", "Director", "Senior PM", "PM"), description_summary (string, 1-2 sentences), fit_signal (string, 1 sentence on why a VP of Product with B2B SaaS and AI product background might fit). If no roles are found, return a JSON object: {"roles": [], "message": "explanation"}. Otherwise return ONLY the JSON array.`;

    const raw = await callWithWebSearch({
      system: SYSTEM,
      prompt,
      maxTokens: 2000,
    });

    const parsed = parseJson<Role[] | RolesResult>(raw);

    if (Array.isArray(parsed)) {
      return { roles: parsed };
    }
    if (parsed && typeof parsed === "object" && "roles" in parsed) {
      return { roles: parsed.roles ?? [], message: parsed.message };
    }
    return { roles: [] };
  } catch (err) {
    console.error("findRoles error:", err);
    return {
      roles: [],
      error:
        err instanceof Error
          ? err.message
          : "Failed to find roles. Check your ANTHROPIC_API_KEY.",
    };
  }
}
