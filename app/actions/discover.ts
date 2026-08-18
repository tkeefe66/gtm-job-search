"use server";

import { requireActor } from "@/lib/require-actor";
import { withBudget } from "@/lib/metered";
import { resolveTenantId } from "@/lib/tenant";

import { callWithWebSearchDetailed } from "@/lib/model-call";
import { arrayUnder, parseOrSalvage } from "@/lib/salvage-call";
import { STARTUP_FIELDS } from "@/lib/types";
import { cacheWriteWarning, countPhrase } from "@/lib/cache-write-warning";
import { supabase } from "@/lib/supabase";
import type { Startup } from "@/lib/types";
import type { HiringSignal } from "@/lib/profile";
import { loadCriteriaAndScoringInputs } from "@/lib/search-criteria";
import { hiringSignalSystem, buildHiringSignalPrompt } from "@/lib/hiring-signal-prompt";
import { legacySignalFrom } from "@/lib/legacy-signal";
import { normalizeCompanyName } from "@/lib/role-key";
import { mergeDiscoveredStartups } from "@/lib/discovered-merge";
import type { DateRange, DiscoveredStartup } from "@/lib/discovered-merge";

export type { DateRange } from "@/lib/discovered-merge";

// DiscoveredStartup and the read-time merge that produces it now live in
// lib/discovered-merge.ts, so the keying/first-wins/append rules are reachable
// from a test. Re-exported here because components/Discover.tsx imports the
// type from this module.
export type { DiscoveredStartup } from "@/lib/discovered-merge";

// A company that just triggered the hiring signal has no req posted yet —
// this app's job is to find the employer BEFORE the posting exists, and a
// company whose signal was months ago is more likely to have opened one.
// 6-18m is offered as an additional option for exactly that reason, not as
// the default: 7d stays the default for scanning fresh signal, the wider
// windows are picked deliberately by whoever wants to look further back.
const DATE_RANGE_LABELS: Record<DateRange, string> = {
  "7d": "in the past 7 days",
  "30d": "in the past 30 days",
  "3m": "in the past 3 months",
  "6m": "in the past 6 months",
  "6-18m": "between 6 and 18 months ago",
  // Never actually interpolated into a prompt — discoverStartupsInner only
  // reads this map when `signal.hasRecency` is true, and "current" is used
  // exclusively for a signal whose hasRecency is false (a standing property
  // has no window). Present only so this Record stays total over DateRange.
  current: "right now",
};

// Compatibility shim for the Watchlist page (app/actions/watchlist.ts,
// components/Watchlist.tsx), which still reads these six fields directly off
// a Startup rather than from `extras`. The new schema asks the model for
// `extras` generically, keyed by the tenant's `hiringSignal.extraFields` —
// for the shipped funding profile those keys happen to be exactly these six
// names (see DEFAULT_PROFILE.hiringSignal in lib/profile.ts), so copying them
// up keeps Watchlist showing exactly what it showed before this task, with
// no change to that file. A tenant whose extraFields name something else
// (contract_value, awarding_agency, …) leaves these legacy fields empty on
// Watchlist — the same quiet degradation this codebase accepts elsewhere for
// a field a domain doesn't have.
const LEGACY_EXTRA_KEYS = [
  "raised",
  "stage",
  "lead_investor",
  "founded",
  "traction",
  "category",
] as const;

function withLegacyExtraFields(s: Startup): Startup {
  const extras = s.extras ?? {};
  const patch: Partial<Startup> = {};
  for (const key of LEGACY_EXTRA_KEYS) {
    if (!s[key] && extras[key]) patch[key] = extras[key];
  }
  return { ...s, ...patch };
}

/** The tenant's hiring signal, for the client component to render around
 *  (header copy, which buttons to show — hasRecency gates the whole window
 *  UI per Binding 4). */
export async function getHiringSignal(): Promise<{ signal: HiringSignal }> {
  const { profile } = await loadCriteriaAndScoringInputs();
  return { signal: profile.hiringSignal };
}

// Returns all saved startups across every cached window, one card per
// EMPLOYER rather than one per row.
//
// Binding 1 (probe A): one employer triggers the signal MANY times. Lockheed
// Martin returned twice under the SAME spelling; RTX three times, across TWO
// different spellings ("RTX (Raytheon)" and "Raytheon (RTX)"), three
// different headquarters. Funding rounds are roughly one-per-company, which
// is why the ORIGINAL dedupe (keep the first occurrence, discard the rest)
// never surfaced this.
//
// Both halves of that are now closed, in two steps. The first kept a LIST of
// signals per key instead of overwriting to one, which fixed the Lockheed
// case. The second — this one — replaced the key itself: it was
// normalizeCompanyName, whose lowercase/trim/collapse could not see that the
// two RTX spellings name one company, and it is now companyIdentityKey
// (lib/role-key.ts), which compares the SET of meaningful words. The probe's
// three RTX rows finally collapse to one card.
//
// The merge is not free of judgement, so it is not silent: every spelling
// that merged away is kept on the card as `alsoKnownAs` for the UI to show.
// See lib/role-key.ts for what the keying rule accepts, and
// lib/discovered-merge.ts — which owns the loop, so the rules are testable —
// for the first-wins and append rules.
export async function getAllDiscoveredStartups(): Promise<{
  startups: DiscoveredStartup[];
  fetchedAt: string | null;
  error?: string;
}> {
  const { data, error } = await supabase.forTenant(await resolveTenantId())
    .from("discovered_startups")
    .select("startups, fetched_at, date_range")
    .order("fetched_at", { ascending: false });

  if (error) return { startups: [], fetchedAt: null, error: error.message };
  if (!data || data.length === 0) return { startups: [], fetchedAt: null };

  // Ordered fetched_at DESC above, which mergeDiscoveredStartups requires:
  // the first occurrence of a key wins the card's core fields.
  return {
    startups: mergeDiscoveredStartups(
      (data as { startups: unknown; date_range: unknown }[]).map((row) => ({
        startups: row.startups as Startup[],
        date_range: row.date_range as string,
      }))
    ),
    fetchedAt: data[0].fetched_at,
  };
}

export async function getDiscoveredStartups(
  dateRange: DateRange,
  searchTerm?: string
): Promise<{ startups: Startup[]; fetchedAt: string | null; error?: string }> {
  const term = searchTerm ?? "";
  const { data, error } = await supabase.forTenant(await resolveTenantId())
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

/**
 * Metered. The exported wrapper owns the session check and the budget; the inner
 * function is the original body, untouched.
 *
 * The reservation is a FLOOR, not an estimate. estimateRunCost prices only the
 * By Role grid and disclaims precision in its own header, so a fabricated number
 * here would look authoritative and be wrong. Reconciliation corrects it from the
 * searches actually issued, and the budget-derived max_uses bounds how far a
 * single call can overshoot before that happens.
 */
export async function discoverStartups(searchTerm?: string,
  dateRange: DateRange = "7d"): Promise<{ startups: Startup[]; error?: string }> {
  const actor = await requireActor();
  const budget = await withBudget({
    action: "discover",
    estimateCents: 25,
    isAdmin: actor.isAdmin,
    fn: () => discoverStartupsInner(searchTerm, dateRange),
  });
  // A cap is a REFUSAL, not a failure — it is shown to the user as its own
  // sentence rather than as "something went wrong".
  if (budget.capped) return { startups: [], error: budget.capped };
  // Presence, not truthiness: an unreachable database reports an empty message.
  if (budget.error !== undefined) return { startups: [], error: budget.error };
  return budget.result!;
}

async function discoverStartupsInner(
  searchTerm?: string,
  dateRange: DateRange = "7d"
): Promise<{ startups: Startup[]; error?: string }> {
  // Session required. Server Actions are RPC endpoints addressed by an ID that
  // ships in the client bundle, so a page-level check does not cover them.
  await requireActor();
  try {
    const { criteria, profile } = await loadCriteriaAndScoringInputs();
    const signal = profile.hiringSignal;
    const focus = searchTerm
      ? `Focus your search specifically on: "${searchTerm}". `
      : "";

    // hasRecency decides, not the passed dateRange directly (Binding 4): a
    // standing-property signal gets no period clause at all, regardless of
    // what window the caller happened to pass.
    const period = signal.hasRecency ? DATE_RANGE_LABELS[dateRange] : null;

    const prompt = buildHiringSignalPrompt({ signal, criteria, period, focus });

    const { text: raw, stopReason } = await callWithWebSearchDetailed({
      system: hiringSignalSystem(signal),
      prompt,
      maxTokens: 4000,
    });

    // maxTokens here is 4000, the lowest of the three search actions, so a
    // TRUNCATED response is likeliest on this path — and parseOrSalvage
    // deliberately does not salvage that one, it rethrows.
    const { items: startups } = await parseOrSalvage<Startup>({
      raw,
      stopReason,
      key: "startups",
      itemNoun: "company",
      itemFields: STARTUP_FIELDS,
      label: `discoverStartups(${dateRange})`,
      extract: arrayUnder<Startup>("startups"),
    });
    const result = startups.map(withLegacyExtraFields);

    // Persist — upsert so re-running refreshes the data.
    //
    // The result was discarded here. Discover's search is billed per web
    // search and the prompt above deliberately asks for MANY of them ("Do
    // multiple searches to ensure completeness"), so a failed cache write that
    // nobody reports means every subsequent Discover click re-bills the whole
    // set with nothing in the log to say why.
    const { error: cacheError } = await supabase.forTenant(await resolveTenantId()).from("discovered_startups").upsert(
      {
        date_range: dateRange,
        search_term: searchTerm ?? "",
        startups: result,
        fetched_at: new Date().toISOString(),
      },
      { onConflict: "tenant_id,date_range,search_term" }
    );

    // Returned on `error`, unlike findAndSaveRoles' separate `cacheWarning`
    // key: Discover's run() sets the banner and does NOT return early, so the
    // warning and the list render together.
    //
    // Be precise about what the user then sees, because it is not these
    // results. run() discards `res.startups` and re-reads the cache — the same
    // table this write just failed against — so the list on screen is the
    // PREVIOUS rounds, not the one just paid for. The banner is therefore the
    // only evidence the new search happened at all. Merging the fresh rows in
    // would need company-level dedupe against the cached ones (see
    // getAllDiscoveredStartups), which is why it is not done inline here.
    if (cacheError) {
      const warning = cacheWriteWarning({
        produced: `Found ${countPhrase(result.length, "startup")}`,
        table: "discovered_startups",
        error: cacheError.message,
      });
      console.error(`discoverStartups: ${warning}`);
      return { startups: result, error: warning };
    }

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
