"use server";

import { resolveCareersUrlWrite } from "@/lib/careers-url-precedence";
import { crawlCompany, type CrawlOutcome } from "@/lib/crawler";
import { DEFAULT_BATCH_LIMIT, DUE_COMPANIES_SQL } from "@/lib/crawl-schedule";
import { normalizeCompanyName } from "@/lib/role-key";
import { rawQuery, supabase } from "@/lib/supabase";
import type { Startup, TrackedCompany } from "@/lib/types";

// Company identity across this file is resolved case-insensitively, but two
// different notions of "same" are in play and neither should stand in for
// the other:
//
//   - SQL `lower()` (below, in resolveExistingCompany) is authoritative for
//     matching against what's already stored in Postgres — it's the only
//     place that can see the DB's actual casing.
//   - normalizeCompanyName / normalizeTitle (lib/role-key.ts) is authoritative
//     for comparisons done entirely in TypeScript (getWatchedCompanyKeys'
//     contract, Discover's membership tests) — it additionally collapses
//     whitespace, including U+00A0, which `lower()` does not.
//
// resolveExistingCompany is the single place every mutating function below
// routes through to find the exact casing already on disk (or fall back to
// the trimmed input for a company that doesn't exist yet). Without it, e.g.
// setTracking("clay", false) against a row stored as "Clay" would match zero
// rows and silently no-op — see follow-up #4's "third half" for the failure
// mode this was written to close.
interface ExistingCompanyRow {
  company: string;
  careers_url: string | null;
}

async function resolveExistingCompany(name: string): Promise<ExistingCompanyRow> {
  const trimmed = name.trim();
  const { data } = await rawQuery<ExistingCompanyRow>(
    `select company, careers_url from watchlist where lower(company) = lower($1) limit 1`,
    [trimmed]
  );
  return data?.[0] ?? { company: trimmed, careers_url: null };
}

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
  const existing = await resolveExistingCompany(startup.company);

  // Discover's prompt (app/actions/discover.ts:82) explicitly allows an
  // empty string for careers_url ("best guess ... or empty string"), and
  // it's only ever a guess by construction — it must never beat a URL
  // already stored, which may have been typed by hand on the Watchlist page
  // to recover a company whose crawl was broken. resolveCareersUrlWrite
  // (lib/careers-url-precedence.ts) encodes that precedence and doubles as
  // the "did the URL actually change" signal: a defined return means it did,
  // which is also exactly when crawl_method/last_crawl_status/
  // last_crawl_error need resetting (see setCareersUrl below for why — a new
  // URL invalidates everything the crawler learned about the old one).
  const careersUrl = resolveCareersUrlWrite(existing.careers_url, startup.careers_url);

  const payload: Record<string, unknown> = {
    company: existing.company,
    tagline: startup.tagline,
    raised: startup.raised,
    stage: startup.stage,
    category: startup.category,
    careers_url: careersUrl,
    headquarters: startup.headquarters,
    source: "discover",
    tracking_enabled: true,
    consecutive_failures: 0,
  };
  if (careersUrl !== undefined) {
    payload.crawl_method = null;
    payload.last_crawl_status = null;
    payload.last_crawl_error = null;
  }

  const { error } = await supabase.from("watchlist").upsert(payload, { onConflict: "company" });
  return { error: error?.message };
}

export async function removeFromWatchlist(company: string): Promise<{ error?: string }> {
  const existing = await resolveExistingCompany(company);
  const { error } = await supabase.from("watchlist").delete().eq("company", existing.company);
  return { error: error?.message };
}

export async function markChecked(company: string): Promise<{ error?: string }> {
  const existing = await resolveExistingCompany(company);
  const { error } = await supabase
    .from("watchlist")
    .update({ last_checked_at: new Date().toISOString() })
    .eq("company", existing.company);
  return { error: error?.message };
}

export async function getWatchedCompanyKeys(): Promise<Set<string>> {
  // Only rows still actively tracked count as "watched" — a company the user
  // stopped tracking (tracking_enabled = false) must be able to show up
  // un-starred in Discover again, not read as permanently claimed.
  //
  // Returns normalizeCompanyName keys, not raw stored strings: this set only
  // ever backs membership tests (Discover.tsx via lib/watched-companies.ts),
  // never display, so resolving the normalization once here — instead of at
  // every call site — is what keeps "Clay" (stored) and "clay" (a fresh
  // Discover result) reading as the same company. Renamed from
  // getWatchedCompanyNames to make that contract change explicit at every
  // call site instead of a same-shaped-but-different-meaning silent swap.
  const { data } = await supabase
    .from("watchlist")
    .select("company")
    .eq("tracking_enabled", true);
  return new Set((data ?? []).map((r: { company: string }) => normalizeCompanyName(r.company)));
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
  const { company } = await resolveExistingCompany(trimmed);

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
  const existing = await resolveExistingCompany(company);
  const patch: Record<string, unknown> = { tracking_enabled: enabled };
  if (enabled) patch.consecutive_failures = 0;
  const { error } = await supabase
    .from("watchlist")
    .update(patch)
    .eq("company", existing.company);
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
  const existing = await resolveExistingCompany(company);
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
    .eq("company", existing.company);
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
