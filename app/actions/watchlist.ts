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
  // Only rows still actively tracked count as "watched" — a company the user
  // stopped tracking (tracking_enabled = false) must be able to show up
  // un-starred in Discover again, not read as permanently claimed.
  const { data } = await supabase
    .from("watchlist")
    .select("company")
    .eq("tracking_enabled", true);
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
  const trimmed = name.trim();
  if (!trimmed) return { error: "Enter a company name." };

  // Company identity is case-insensitive everywhere else in the tracking
  // pipeline (ingest-roles.ts's dedupe lookup is lower()-based), but the
  // watchlist's unique index is on raw text. Without this lookup, typing
  // "clay" when "Clay" is already tracked would upsert a second row —
  // billed separately — and ingestRoles' now-case-insensitive dedupe query
  // would still find nothing under the new casing's exact string, so every
  // role would re-insert as a duplicate "New" job. Reusing the exact stored
  // string keeps it to one row.
  const { data: existingRows } = await rawQuery<{ company: string }>(
    `select company from watchlist where lower(company) = lower($1) limit 1`,
    [trimmed]
  );
  const company = existingRows?.[0]?.company ?? trimmed;

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
      // A new careers URL invalidates whatever the crawler learned about the
      // old one — a page misclassified as a JS shell (see lib/page-extract.ts's
      // MIN_JOB_LINKS/JOB_LINK_PATTERN gaps) pins crawl_method to 'search'
      // forever with no other reset path. Clearing it here is also the only
      // manual reset the user has.
      crawl_method: null,
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
