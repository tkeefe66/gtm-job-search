"use server";

import { requireActor } from "@/lib/require-actor";
import { withBudget } from "@/lib/metered";
import { resolveTenantId } from "@/lib/tenant";

import { callWithWebSearch, parseJson } from "@/lib/model-call";
import { cacheWriteWarning, countPhrase } from "@/lib/cache-write-warning";
import { supabase } from "@/lib/supabase";
import type { Startup } from "@/lib/types";
import type { HiringSignal } from "@/lib/profile";
import { loadCriteriaAndScoringInputs } from "@/lib/search-criteria";
import { hiringSignalSystem, buildHiringSignalPrompt } from "@/lib/hiring-signal-prompt";
import { legacySignalFrom } from "@/lib/legacy-signal";
import { normalizeCompanyName } from "@/lib/role-key";

export type DateRange = "7d" | "30d" | "3m" | "6m" | "6-18m" | "current";

// A startup annotated with the date-range window of the discovered_startups
// row it was read from. getAllDiscoveredStartups() dedupes by company across
// every cached window, so this is how a caller (Discover.tsx) tells a company
// found last week apart from one found 6-18 months ago.
export type DiscoveredStartup = Startup & {
  discovered_range: DateRange;
  /**
   * Every distinct signal this employer triggered under ONE spelling of its
   * name, across every cached row — including duplicate returns within one
   * search (Probe A returned Lockheed Martin twice, under the same spelling
   * both times, and the old dedupe kept only the first, silently dropping
   * the second real contract) and legitimate repeats across different
   * windows. `signal` above still holds just the most recent one; this is
   * the full list a card renders. Never empty when `signals.length` matters
   * — a row whose signal composed to "" (no `signal` field and nothing to
   * compose from `legacySignalFrom`) simply contributes no entry.
   *
   * NOT solved by this: name VARIANTS of the same real employer, spelled
   * differently. Probe A also returned RTX as both "RTX (Raytheon)" and
   * "Raytheon (RTX)" — two different strings that normalizeCompanyName
   * (lowercase/trim/whitespace-collapse only, see lib/role-key.ts) does not
   * resolve to the same key, so those still render as two separate cards.
   * See the longer note on getAllDiscoveredStartups below.
   */
  signals: string[];
};

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

// Returns all saved startups across every date range, deduped by normalized
// company string — not by row, and not by the OLD raw `.toLowerCase().trim()`.
//
// Binding 1 (probe A): one employer triggers the signal MANY times.
// Lockheed Martin returned twice under the SAME spelling; RTX three times,
// across TWO different spellings ("RTX (Raytheon)" and "Raytheon (RTX)"),
// three different headquarters. Funding rounds are roughly one-per-company,
// which is why the old dedupe (keep the first occurrence, discard the rest)
// never surfaced this: for repeats under one spelling it silently dropped
// every signal after the first.
//
// What this fix actually does, precisely: keys on normalizeCompanyName
// (lib/role-key.ts — the SAME normalizer watchlist/ingest-roles use, not a
// second one), which is lowercase + trim + whitespace-collapse, nothing
// more, and keeps a LIST of every signal seen under that key instead of
// overwriting to one. That closes the Lockheed case completely — two exact
// (post-normalization) repeats now become one card with two signal lines
// instead of one card with the second silently discarded.
//
// What it does NOT do: merge name VARIANTS of the same real employer.
// normalizeCompanyName performs no aliasing — "RTX (Raytheon)" and
// "Raytheon (RTX)" normalize to two different strings and still render as
// two separate cards, each with its own signal(s), rather than the one card
// a human reader would recognize them as. The probe's three RTX rows
// therefore collapse to two cards here, not one. Fuzzy/alias matching to
// close that gap is a real, separate design problem (what counts as "the
// same company" — substring match? a canonical-name lookup? something else
// entirely?) and is deliberately not attempted in this task.
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

  // Rows are ordered fetched_at descending, so the FIRST time a key is seen
  // sets the card's core fields (company/tagline/careers_url/headquarters/
  // location) from the most-recently-fetched occurrence. Every later
  // occurrence of the same key — whether from the same row (a search that
  // returned one employer more than once) or a different one — never
  // overwrites the core and never creates a second card; it only appends its
  // signal line, deduped against exact repeats.
  const byKey = new Map<string, DiscoveredStartup>();
  for (const row of data) {
    for (const s of row.startups as Startup[]) {
      const key = normalizeCompanyName(s.company);
      const signalLine = s.signal ?? legacySignalFrom(s);
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, {
          ...s,
          discovered_range: row.date_range as DateRange,
          signals: signalLine ? [signalLine] : [],
        });
      } else if (signalLine && !existing.signals.includes(signalLine)) {
        existing.signals.push(signalLine);
      }
    }
  }

  return { startups: Array.from(byKey.values()), fetchedAt: data[0].fetched_at };
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

    const raw = await callWithWebSearch({
      system: hiringSignalSystem(signal),
      prompt,
      maxTokens: 4000,
    });

    const startups = parseJson<Startup[]>(raw);
    const result = (Array.isArray(startups) ? startups : []).map(withLegacyExtraFields);

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
