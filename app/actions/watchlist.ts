"use server";

import { crawlCompany, type CrawlOutcome } from "@/lib/crawler";
import { DEFAULT_BATCH_LIMIT, DUE_COMPANIES_SQL } from "@/lib/crawl-schedule";
import { rawQuery, supabase } from "@/lib/supabase";
import type { Startup, TrackedCompany } from "@/lib/types";

export interface WatchlistEntry extends Startup {
  id: string;
  added_at: string;
  last_checked_at: string | null;
}

export async function getWatchlist(): Promise<{ entries: WatchlistEntry[]; error?: string }> {
  const { data, error } = await supabase
    .from("watchlist")
    .select("*")
    .order("added_at", { ascending: false });
  if (error) return { entries: [], error: error.message };
  return { entries: (data ?? []) as WatchlistEntry[] };
}

export async function addToWatchlist(startup: Startup): Promise<{ error?: string }> {
  const { error } = await supabase.from("watchlist").upsert(
    {
      company: startup.company,
      tagline: startup.tagline,
      raised: startup.raised,
      stage: startup.stage,
      category: startup.category,
      // Discover's prompt (app/actions/discover.ts:82) explicitly allows an
      // empty string for careers_url ("best guess ... or empty string"), and
      // the builder's upsert writes every key present in the payload
      // (lib/supabase.ts:170,179-181) — so an unconditional write here would
      // blank out a URL a prior crawl had resolved for this company, forcing
      // a wasted resolveCareersUrl() search call (or a false "needs_url"
      // failure) on the next crawl. Omit the key instead of writing "".
      careers_url: startup.careers_url || undefined,
      headquarters: startup.headquarters,
      source: "discover",
      tracking_enabled: true,
      consecutive_failures: 0,
    },
    { onConflict: "company" }
  );
  return { error: error?.message };
}

export async function removeFromWatchlist(company: string): Promise<{ error?: string }> {
  const { error } = await supabase.from("watchlist").delete().eq("company", company);
  return { error: error?.message };
}

export async function markChecked(company: string): Promise<{ error?: string }> {
  const { error } = await supabase
    .from("watchlist")
    .update({ last_checked_at: new Date().toISOString() })
    .eq("company", company);
  return { error: error?.message };
}

export async function getWatchedCompanyNames(): Promise<Set<string>> {
  const { data } = await supabase.from("watchlist").select("company");
  return new Set((data ?? []).map((r: { company: string }) => r.company));
}

export async function getTrackedCompanies(): Promise<{
  companies: TrackedCompany[];
  error?: string;
}> {
  const { data, error } = await supabase
    .from("watchlist")
    .select("*")
    .order("added_at", { ascending: false });
  if (error) return { companies: [], error: error.message };
  return { companies: (data ?? []) as TrackedCompany[] };
}

/**
 * Track any company by name, whether or not it ever appeared in Discover.
 * Runs the first crawl immediately so the user sees a result now rather than
 * waiting for the next cron cycle.
 */
export async function trackCompanyByName(
  name: string
): Promise<{ outcome?: CrawlOutcome; error?: string }> {
  const company = name.trim();
  if (!company) return { error: "Enter a company name." };

  const { error } = await supabase.from("watchlist").upsert(
    {
      company,
      source: "manual",
      tracking_enabled: true,
      consecutive_failures: 0,
    },
    { onConflict: "company" }
  );
  if (error) {
    return { error: `Could not track "${company}" — ${error.message}` };
  }

  const outcome = await crawlCompany(company);
  return { outcome };
}

export async function setTracking(
  company: string,
  enabled: boolean
): Promise<{ error?: string }> {
  const patch: Record<string, unknown> = { tracking_enabled: enabled };
  if (enabled) patch.consecutive_failures = 0;
  const { error } = await supabase
    .from("watchlist")
    .update(patch)
    .eq("company", company);
  return { error: error?.message };
}

export async function setCareersUrl(
  company: string,
  url: string
): Promise<{ error?: string }> {
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return { error: "Enter a full URL starting with http:// or https://" };
  }
  const { error } = await supabase
    .from("watchlist")
    .update({
      careers_url: trimmed,
      last_crawl_status: null,
      last_crawl_error: null,
      consecutive_failures: 0,
    })
    .eq("company", company);
  return { error: error?.message };
}

export async function checkCompanyNow(company: string): Promise<CrawlOutcome> {
  return crawlCompany(company);
}

export async function getDueCompanies(
  limit: number = DEFAULT_BATCH_LIMIT
): Promise<{ companies: string[]; error?: string }> {
  const { data, error } = await rawQuery<{ company: string }>(DUE_COMPANIES_SQL, [
    limit,
  ]);
  if (error) return { companies: [], error: error.message };
  return { companies: (data ?? []).map((r) => r.company) };
}
