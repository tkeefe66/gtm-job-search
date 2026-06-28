"use server";

import { callWithWebSearch, parseJson } from "@/lib/anthropic";
import type { Startup } from "@/lib/types";

const SYSTEM =
  "You are a startup funding analyst. Search for the most notable AI and tech startup funding rounds from the past 7 days. Focus on seed through Series B companies. Return ONLY valid JSON, no markdown, no preamble.";

export async function discoverStartups(
  searchTerm?: string
): Promise<{ startups: Startup[]; error?: string }> {
  try {
    const focus = searchTerm
      ? `Focus your search specifically on: "${searchTerm}". `
      : "";

    const prompt = `${focus}Find the 5-10 most notable AI and tech startup funding rounds announced in the past 7 days (seed through Series B). For each, return a JSON array of objects with these exact fields: company (string), tagline (string), raised (string e.g. "$12M"), stage (string e.g. "Series A"), lead_investor (string), founded (string e.g. "2023"), traction (string, one line on momentum), careers_url (string, best guess careers page URL or empty string), category (string e.g. "AI Infra", "Dev Tools"). Return ONLY the JSON array.`;

    const raw = await callWithWebSearch({
      system: SYSTEM,
      prompt,
      maxTokens: 2000,
    });

    const startups = parseJson<Startup[]>(raw);
    return { startups: Array.isArray(startups) ? startups : [] };
  } catch (err) {
    console.error("discoverStartups error:", err);
    return {
      startups: [],
      error:
        err instanceof Error
          ? err.message
          : "Failed to discover startups. Check your ANTHROPIC_API_KEY.",
    };
  }
}
