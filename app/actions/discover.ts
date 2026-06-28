"use server";

import { callWithWebSearch, parseJson } from "@/lib/anthropic";
import { supabase } from "@/lib/supabase";
import type { Startup } from "@/lib/types";

const SYSTEM =
  "You are a startup funding analyst. Search for the most notable AI and tech startup funding rounds. Focus on seed through Series B companies. Return ONLY valid JSON, no markdown, no preamble.";

export type DateRange = "7d" | "30d" | "3m" | "6m";

const DATE_RANGE_LABELS: Record<DateRange, string> = {
  "7d": "the past 7 days",
  "30d": "the past 30 days",
  "3m": "the past 3 months",
  "6m": "the past 6 months",
};

export async function getDiscoveredStartups(
  dateRange: DateRange,
  searchTerm?: string
): Promise<{ startups: Startup[]; fetchedAt: string | null; error?: string }> {
  const term = searchTerm ?? null;
  const { data, error } = await supabase
    .from("discovered_startups")
    .select("startups, fetched_at")
    .eq("date_range", dateRange)
    .eq("search_term", term ?? "")
    .maybeSingle();

  if (error) return { startups: [], fetchedAt: null, error: error.message };
  if (!data) return { startups: [], fetchedAt: null };
  return {
    startups: data.startups as Startup[],
    fetchedAt: data.fetched_at,
  };
}

export async function discoverStartups(
  searchTerm?: string,
  dateRange: DateRange = "7d"
): Promise<{ startups: Startup[]; error?: string }> {
  try {
    const focus = searchTerm
      ? `Focus your search specifically on: "${searchTerm}". `
      : "";

    const period = DATE_RANGE_LABELS[dateRange];
    const prompt = `${focus}Find the 5-10 most notable AI and tech startup funding rounds announced in ${period} (seed through Series B). For each, return a JSON array of objects with these exact fields: company (string), tagline (string), raised (string e.g. "$12M"), stage (string e.g. "Series A"), lead_investor (string), founded (string e.g. "2023"), traction (string, one line on momentum), careers_url (string, best guess careers page URL or empty string), category (string e.g. "AI Infra", "Dev Tools"). Return ONLY the JSON array.`;

    const raw = await callWithWebSearch({
      system: SYSTEM,
      prompt,
      maxTokens: 2000,
    });

    const startups = parseJson<Startup[]>(raw);
    const result = Array.isArray(startups) ? startups : [];

    // Persist to Supabase — upsert so re-running refreshes the data.
    await supabase.from("discovered_startups").upsert(
      {
        date_range: dateRange,
        search_term: searchTerm ?? "",
        startups: result,
        fetched_at: new Date().toISOString(),
      },
      { onConflict: "date_range,search_term" }
    );

    return { startups: result };
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
