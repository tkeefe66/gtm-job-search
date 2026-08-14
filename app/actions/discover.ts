"use server";

import { callWithWebSearch, parseJson } from "@/lib/anthropic";
import { supabase } from "@/lib/supabase";
import type { Startup } from "@/lib/types";
import { dateContextLine, loadCriteria } from "@/lib/search-criteria";

const SYSTEM =
  "You are a startup funding analyst. Your job is to find every significant AI and tech startup funding round for the given period — do not curate down to a short list, capture all notable rounds. Search multiple sources: TechCrunch, Crunchbase, The Information, Bloomberg, Forbes, VentureBeat, Reuters, WSJ, Business Insider, and X/Twitter funding announcements. Focus exclusively on Series B and above (Series B, Series C, Series D+, Late Stage, Growth, Pre-IPO). Exclude seed, pre-seed, and Series A rounds. Prioritize completeness — it is better to return 20 results than to miss a major round. Return ONLY valid JSON, no markdown, no preamble.";

export type DateRange = "7d" | "30d" | "3m" | "6m" | "6-18m";

// A startup annotated with the date-range window of the discovered_startups
// row it was read from. getAllDiscoveredStartups() dedupes by company across
// every cached window, so this is how a caller (Discover.tsx) tells a company
// found last week apart from one found 6-18 months ago.
export type DiscoveredStartup = Startup & { discovered_range: DateRange };

// 6-18m is offered as an additional option, not the default: a company that
// closed a round last week has no RevOps req yet, while a company hiring GTM
// systems people today more plausibly raised 6-18 months ago. 7d stays the
// default for scanning fresh news; the wider windows are picked deliberately.
const DATE_RANGE_LABELS: Record<DateRange, string> = {
  "7d": "in the past 7 days",
  "30d": "in the past 30 days",
  "3m": "in the past 3 months",
  "6m": "in the past 6 months",
  "6-18m": "between 6 and 18 months ago",
};

// Returns all saved startups across every date range, deduped by company name.
export async function getAllDiscoveredStartups(): Promise<{
  startups: DiscoveredStartup[];
  fetchedAt: string | null;
  error?: string;
}> {
  const { data, error } = await supabase
    .from("discovered_startups")
    .select("startups, fetched_at, date_range")
    .order("fetched_at", { ascending: false });

  if (error) return { startups: [], fetchedAt: null, error: error.message };
  if (!data || data.length === 0) return { startups: [], fetchedAt: null };

  // Flatten all startups, dedupe by company name (keep first occurrence).
  // Rows are ordered fetched_at descending, so when the same company shows
  // up in more than one cached window, the occurrence kept here — and the
  // discovered_range attached to it — is whichever row was fetched most
  // recently, not necessarily the narrowest or widest window searched.
  const seen = new Set<string>();
  const all: DiscoveredStartup[] = [];
  for (const row of data) {
    for (const s of row.startups as Startup[]) {
      const key = s.company.toLowerCase().trim();
      if (!seen.has(key)) {
        seen.add(key);
        all.push({ ...s, discovered_range: row.date_range as DateRange });
      }
    }
  }

  return { startups: all, fetchedAt: data[0].fetched_at };
}

export async function getDiscoveredStartups(
  dateRange: DateRange,
  searchTerm?: string
): Promise<{ startups: Startup[]; fetchedAt: string | null; error?: string }> {
  const term = searchTerm ?? "";
  const { data, error } = await supabase
    .from("discovered_startups")
    .select("startups, fetched_at")
    .eq("date_range", dateRange)
    .eq("search_term", term)
    .order("fetched_at", { ascending: false })
    .limit(1)
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
    const criteria = await loadCriteria();
    const focus = searchTerm
      ? `Focus your search specifically on: "${searchTerm}". `
      : "";

    const period = DATE_RANGE_LABELS[dateRange];
    const prompt = `${focus}Search TechCrunch, Crunchbase, The Information, Bloomberg, Forbes, VentureBeat, Reuters, and WSJ for ALL AI and tech startup funding rounds announced ${period}. Only include Series B and above — exclude seed, pre-seed, and Series A. Do multiple searches to ensure completeness: search "Series B funding ${period}", "Series C funding ${period}", "startup raises millions ${period}", and category-specific searches like "AI startup funding ${period}". Return up to 20 results — do not cut the list short. ${dateContextLine()} IMPORTANT location preference (soft, for ranking — do not hard-exclude): prioritize companies that hire remotely or have a Denver/Colorado presence. For reference, the roles being sought follow this rule: ${criteria.locationRule} For each, return a JSON array of objects with these exact fields: company (string), tagline (string), raised (string e.g. "$400M"), stage (string e.g. "Series D"), lead_investor (string), founded (string e.g. "2023"), traction (string, one concrete metric or momentum signal), careers_url (string, best guess careers page URL or empty string), category (string e.g. "AI Infra", "Dev Tools", "Voice AI", "Agentic AI"), headquarters (string, city and state e.g. "San Francisco, CA" or "Remote" or "New York, NY"). Return ONLY the JSON array.`;

    const raw = await callWithWebSearch({
      system: SYSTEM,
      prompt,
      maxTokens: 4000,
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
