"use server";

import { supabase } from "@/lib/supabase";
import type { Startup } from "@/lib/types";

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
      careers_url: startup.careers_url,
      headquarters: startup.headquarters,
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
