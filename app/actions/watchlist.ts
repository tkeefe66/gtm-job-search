"use server";

import { requireActor } from "@/lib/require-actor";
import { crawlQuotaVerdict } from "@/lib/crawl-quota";
import { resolveTenantId } from "@/lib/tenant";

import { resolveCareersUrlWrite } from "@/lib/careers-url-precedence";
import { crawlCompany, type CrawlOutcome } from "@/lib/crawler";
import { DEFAULT_BATCH_LIMIT, DUE_COMPANIES_SQL, crawlIntervalError } from "@/lib/crawl-schedule";
import { findExistingCompany } from "@/lib/find-existing-company";
import { normalizeCompanyName } from "@/lib/role-key";
import { watchlistSignalFields } from "@/lib/watchlist-signal";
import { withBudget } from "@/lib/metered";
import { rawQuery, supabase } from "@/lib/supabase";
import { UNDESCRIBED_DB_ERROR, describeWriteFailure } from "@/lib/write-failure";
import type { Startup, TrackedCompany } from "@/lib/types";

// Company identity across this file is resolved case-insensitively using a
// SINGLE normalizer — normalizeCompanyName (lib/role-key.ts) — for every
// comparison, SQL and TypeScript alike. This file used to also match with
// SQL `lower(company) = lower($1)`, on the theory that `lower()` and
// normalizeCompanyName were just two flavors of "case-insensitive" and it
// didn't matter which language did the comparing. Task 5's review found that
// theory wrong: SQL `lower()` does not collapse internal whitespace (or
// reliably fold U+00A0 the way JS's `\s` does), so a row stored as
// "Big  Co" (double space) would not match a `lower()` lookup for "Big Co" —
// resolveExistingCompany would then fall back to the trimmed input, and the
// write that followed (`.eq("company", "Big Co")`) matched zero rows and
// silently no-opped. That is the same failure class follow-up #4's "third
// half" named, reached through whitespace instead of casing.
//
// Postgres's own \s/lower() semantics for U+00A0 are locale-dependent and
// not verifiable without a database, so the fix is to stop straddling two
// languages rather than try to replicate normalizeCompanyName in SQL: read
// the watchlist's company names (the watchlist is a single user's list of
// tens of rows — a full read is cheap) and do the actual match in
// TypeScript, via findExistingCompany (lib/find-existing-company.ts), which
// is the same normalizer every other TS-side company-identity comparison in
// this codebase uses. Do not "optimize" this back into a `lower()` query —
// that reintroduces the exact bug this comment describes.
interface ExistingCompanyRow {
  company: string;
  careers_url: string | null;
}

interface ResolvedCompany {
  row: ExistingCompanyRow;
  /**
   * The watchlist read itself failed, so `row` and `found` are both guesses
   * rather than answers.
   *
   * Kept separate from `found` deliberately. Collapsing them would be the
   * original bug wearing a new name: "no such company" and "I could not look"
   * license completely different writes. This flag is what stops the second
   * being treated as the first — see addToWatchlist (which must not let a
   * guessed careers_url overwrite a stored one) and trackCompanyByName (which
   * must not upsert under an unverified casing).
   */
  readFailed: boolean;
  // False means no row matched under normalizeCompanyName — `row.company`
  // is then just the trimmed input, not a real stored value. Callers that
  // mutate an existing row (setTracking, markChecked, setCareersUrl,
  // removeFromWatchlist) must check this and fail loudly instead of issuing
  // a write that's guaranteed to match zero rows — see the resolveWriteTarget
  // helper below.
  found: boolean;
}

async function resolveExistingCompany(name: string): Promise<ResolvedCompany> {
  const trimmed = name.trim();
  const { data, error } = await rawQuery<ExistingCompanyRow>(
    `select company, careers_url from watchlist where tenant_id = $1`,
    [await resolveTenantId()],
    await resolveTenantId()
  );

  // The error used to be discarded here, which made a failed read
  // indistinguishable from an empty watchlist: `found: false` and
  // `careers_url: null`. Both of those are ACTIVELY WRONG rather than merely
  // conservative, and each one licensed a write — a guessed careers_url over a
  // hand-typed one, and a second watchlist row under a different casing.
  //
  // Still fails soft (this is a read on the path of several writes, and
  // throwing would take the whole action down), but soft to a value that
  // cannot authorize either write. That is the distinction: readAllSettings
  // fails soft to the shipped defaults, which are SAFE; this used to fail soft
  // to "no such company", which is not.
  const readFailed = error !== null && error !== undefined;
  if (readFailed) {
    console.error(
      `watchlist: could not read the watchlist to resolve "${trimmed}" — ` +
        `${error.message || UNDESCRIBED_DB_ERROR}. Treating the stored row as UNKNOWN, ` +
        `which blocks any write that would depend on knowing it.`
    );
  }

  const match = findExistingCompany(data ?? [], trimmed);
  return match
    ? { row: match, found: true, readFailed }
    : { row: { company: trimmed, careers_url: null }, found: false, readFailed };
}

// Shared guard for the four functions that mutate an EXISTING row
// (setTracking, markChecked, setCareersUrl, removeFromWatchlist) rather than
// upserting one (trackCompanyByName, addToWatchlist, where "not found" is
// the normal first-time-tracking case, not an error). lib/supabase.ts's
// query builder reports { error: null } no matter how many rows an
// UPDATE/DELETE matched — see the module comment on setTracking below — so
// without this check, a name that doesn't resolve to a stored row (a race
// with another tab's delete, or simply a typo) silently no-ops: the caller
// sees no error and the UI reports success for a write that touched nothing.
/**
 * Why the two UPSERT paths refuse when the watchlist could not be read.
 *
 * addToWatchlist and trackCompanyByName deliberately skip resolveWriteTarget:
 * for them "not found" is the normal first-time case, not an error. But
 * "could not look" is NOT the same as "not found", and both of them depend on
 * the lookup for the same thing — the canonical STORED casing. The unique
 * index is on raw text, so writing under an unverified name is how "clay"
 * becomes a second row beside "Clay": billed separately, and invisible to
 * ingestRoles' dedupe, so every role re-inserts as a duplicate "New" job.
 *
 * Shared so the two cannot drift. trackCompanyByName refused and
 * addToWatchlist did not, which left the identical hazard open on the Discover
 * tab's Watch button.
 */
function readFailureError(name: string, action: string): string {
  return (
    `Could not check the watchlist before ${action} "${name}" — the database could not ` +
    `be read. Nothing was written, because acting on an unverified company name can ` +
    `create a duplicate company. Try again.`
  );
}

async function resolveWriteTarget(
  company: string
): Promise<{ company: string; careers_url: string | null; error?: string }> {
  const { row, found, readFailed } = await resolveExistingCompany(company);
  // Told apart from "not on the watchlist", because they are not the same
  // claim and the old message asserted the wrong one: a user shown `"Acme" is
  // not on the watchlist` for a database outage goes looking for a company
  // that is sitting right there.
  if (readFailed) {
    return {
      ...row,
      error:
        `Could not check whether "${row.company}" is on the watchlist — the database ` +
        `could not be read, so nothing was changed. Try again.`,
    };
  }
  if (!found) {
    return { ...row, error: `"${row.company}" is not on the watchlist.` };
  }
  return row;
}

export interface WatchlistEntry extends Startup {
  id: string;
  added_at: string;
  last_checked_at: string | null;
}

export async function getWatchlist(): Promise<{ entries: WatchlistEntry[]; error?: string }> {
  // Session required. Server Actions are RPC endpoints addressed by an ID that
  // ships in the client bundle, so a page-level check does not cover them.
  await requireActor();
  const { data, error } = await supabase.forTenant(await resolveTenantId())
    .from("watchlist")
    .select("*")
    .order("added_at", { ascending: false });
  if (error) return { entries: [], error: error.message };
  return { entries: (data ?? []) as WatchlistEntry[] };
}

/**
 * Refuses a new tracked company once the tenant is at their quota.
 *
 * Enforced in the ACTION, not the button: a server action is an RPC endpoint,
 * so a limit the UI respects is one the action still has to check.
 *
 * Counts only rows with tracking_enabled — an untracked row costs no crawl
 * capacity, and counting it would punish the soft-disable that exists precisely
 * so history survives.
 */
async function quotaBlocks(): Promise<string | null> {
  const actor = await requireActor();
  const tenantId = await resolveTenantId();

  const { data: counted, error: countError } = await rawQuery<{ n: string }>(
    `select count(*) n from watchlist where tenant_id = $1 and tracking_enabled = true`,
    [tenantId],
    tenantId
  );
  // A failed count must NOT read as zero: that would silently grant unlimited
  // tracking, which is the same class of bug as a failed count unlocking a
  // delete guard.
  if (countError) return "Could not check your tracking limit — nothing was changed.";

  const { data: quotaRows } = await rawQuery<{ crawl_quota: number | null }>(
    `select crawl_quota from users where id = $1`,
    [tenantId]
  );
  const { data: defaults } = await rawQuery<{ value: unknown }>(
    `select value from platform_settings where key = 'defaultCrawlQuota'`
  );
  const fallback = typeof defaults[0]?.value === "number" ? defaults[0].value : 10;

  const verdict = crawlQuotaVerdict({
    tracked: Number(counted[0]?.n ?? 0),
    quota: quotaRows[0]?.crawl_quota ?? fallback,
    isAdmin: actor.isAdmin,
  });
  return verdict.allow ? null : (verdict.reason ?? "Tracking limit reached.");
}

export async function addToWatchlist(startup: Startup): Promise<{ error?: string }> {
  // Session required. Server Actions are RPC endpoints addressed by an ID that
  // ships in the client bundle, so a page-level check does not cover them.
  await requireActor();
  // Checked here as well as in setTracking: this row is created with
  // tracking_enabled defaulting to true, so without it the quota is bypassed by
  // the most common path into the watchlist.
  {
    const blocked = await quotaBlocks();
    if (blocked) return { error: blocked };
  }
  // "not found" is the normal case here (a company Discover has never seen
  // tracked before) — this is an upsert, so `found` is irrelevant and only
  // `row` is used.
  const { row: existing, readFailed } = await resolveExistingCompany(startup.company);

  // Refused for the same reason trackCompanyByName refuses — see
  // readFailureError. This path had the gap open: it is the Discover tab's
  // Watch button, which is exactly where an unverified casing would land.
  if (readFailed) {
    return { error: readFailureError(startup.company.trim(), "watching") };
  }

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
  // `{ known: false }` when the read failed, NOT `existing.careers_url` — which
  // is null in that case and would read as "nothing stored", letting the guess
  // through and clobbering a hand-typed URL.
  //
  // DEFENCE IN DEPTH as of the readFailed guard above: that guard returns
  // before this line, so the `{ known: false }` branch is currently
  // unreachable from here. Kept anyway, and kept as a discriminated union,
  // because the union is what makes the unsafe call a COMPILE error for the
  // next caller — the guard only protects this one.
  const careersUrl = resolveCareersUrlWrite(
    readFailed ? { known: false } : { known: true, url: existing.careers_url },
    startup.careers_url
  );

  // The six venture-shaped columns below are kept for rows and readers that
  // still use them; `signal`/`extras` are what actually generalise across
  // careers (db/migrations/012). A defence contractor's contract award reached
  // this table in NO form before those two columns existed — the legacy copy
  // in withLegacyExtraFields only finds keys the funding profile happens to
  // name. Derived by a pure helper so the fallback rule is testable.
  const { signal, extras } = watchlistSignalFields(startup);

  const payload: Record<string, unknown> = {
    company: existing.company,
    tagline: startup.tagline,
    raised: startup.raised,
    stage: startup.stage,
    category: startup.category,
    careers_url: careersUrl,
    headquarters: startup.headquarters,
    signal,
    extras,
    source: "discover",
    tracking_enabled: true,
    consecutive_failures: 0,
  };
  if (careersUrl !== undefined) {
    payload.crawl_method = null;
    payload.last_crawl_status = null;
    payload.last_crawl_error = null;
  }

  const { error } = await supabase.forTenant(await resolveTenantId()).from("watchlist").upsert(payload, { onConflict: "tenant_id,company" });
  return { error: error?.message };
}

// Exported as the explicit hard-delete (setTracking(company, false) is the
// soft-disable everything else uses — see its comment). Currently has no
// caller in the app; kept available for a future "remove entirely" action.
export async function removeFromWatchlist(company: string): Promise<{ error?: string }> {
  // Session required. Server Actions are RPC endpoints addressed by an ID that
  // ships in the client bundle, so a page-level check does not cover them.
  await requireActor();
  const target = await resolveWriteTarget(company);
  if (target.error) return { error: target.error };
  const { error } = await supabase.forTenant(await resolveTenantId()).from("watchlist").delete().eq("company", target.company);
  return { error: error?.message };
}

// Currently has no caller in the app (checkCompanyNow/crawlCompany update
// last_checked_at themselves as part of a full crawl). Kept exported for a
// lighter-weight "mark seen without crawling" action.
export async function markChecked(company: string): Promise<{ error?: string }> {
  // Session required. Server Actions are RPC endpoints addressed by an ID that
  // ships in the client bundle, so a page-level check does not cover them.
  await requireActor();
  const target = await resolveWriteTarget(company);
  if (target.error) return { error: target.error };
  const { error } = await supabase.forTenant(await resolveTenantId())
    .from("watchlist")
    .update({ last_checked_at: new Date().toISOString() })
    .eq("company", target.company);
  return { error: error?.message };
}

export async function getWatchedCompanyKeys(): Promise<{
  keys: Set<string>;
  /** Present (empty string included) when the lookup failed. Presence, not truthiness. */
  error?: string;
}> {
  // Session required. Server Actions are RPC endpoints addressed by an ID that
  // ships in the client bundle, so a page-level check does not cover them.
  await requireActor();
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
  const { data, error } = await supabase.forTenant(await resolveTenantId())
    .from("watchlist")
    .select("company")
    .eq("tracking_enabled", true);

  // The error used to be dropped, leaving a bare empty Set — "nothing is
  // watched", which is a perfectly plausible answer and therefore
  // indistinguishable from the failure. Every company then rendered un-starred
  // with a live Track button, and that button writes.
  //
  // Reported rather than swallowed, and the KEYS still come back so a caller
  // that only paints a star can carry on. Callers that would act on the
  // absence must check `error` — see untrackedFromWatched in
  // lib/untracked-companies.ts, which answers "nothing to track" instead of
  // "everything to track" when this failed.
  if (error) {
    console.error(
      `watchlist: could not read which companies are tracked — ` +
        `${error.message || UNDESCRIBED_DB_ERROR}`
    );
    return { keys: new Set<string>(), error: error.message };
  }

  return {
    keys: new Set(
      (data ?? []).map((r: { company: string }) => normalizeCompanyName(r.company))
    ),
  };
}

export async function getTrackedCompanies(): Promise<{
  companies: TrackedCompany[];
  error?: string;
}> {
  // Session required. Server Actions are RPC endpoints addressed by an ID that
  // ships in the client bundle, so a page-level check does not cover them.
  await requireActor();
  const { data, error } = await supabase.forTenant(await resolveTenantId())
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
  // Session required. Server Actions are RPC endpoints addressed by an ID that
  // ships in the client bundle, so a page-level check does not cover them.
  await requireActor();
  // Before the crawl, not after: this path tracks AND crawls immediately, so a
  // check afterwards would already have spent the call it was meant to prevent.
  {
    const blocked = await quotaBlocks();
    if (blocked) return { error: blocked };
  }
  const trimmed = name.trim();
  if (!trimmed) return { error: "Enter a company name." };

  // Company identity is case-insensitive everywhere else in the tracking
  // pipeline (ingest-roles.ts's dedupe lookup is lower()-based), but the
  // watchlist's unique index is on raw text. Without this lookup, typing
  // "clay" when "Clay" is already tracked would upsert a second row —
  // billed separately — and ingestRoles' now-case-insensitive dedupe query
  // would still find nothing under the new casing's exact string, so every
  // role would re-insert as a duplicate "New" job. Reusing the exact stored
  // string keeps it to one row. This is an upsert, like addToWatchlist —
  // "not found" is the normal first-time-tracking case, not an error.
  const {
    row: { company },
    readFailed,
  } = await resolveExistingCompany(trimmed);

  // Refused rather than guessed. The watchlist's unique index is on RAW text,
  // so this lookup is the only thing that keeps "clay" from upserting a second
  // row beside a stored "Clay" — billed separately, and invisible to
  // ingestRoles' dedupe, so every role re-inserts as a duplicate "New" job.
  // With the read failed we do not know the canonical casing, and a wrong
  // guess is permanent. Not tracking is recoverable by clicking again; a
  // duplicate row is deleted by hand.
  //
  // This uses the existing error channel rather than throwing, so the caller
  // renders it like any other refusal.
  if (readFailed) {
    return { error: readFailureError(trimmed, "tracking") };
  }

  const { error } = await supabase.forTenant(await resolveTenantId()).from("watchlist").upsert(
    {
      company,
      source: "manual",
      tracking_enabled: true,
      consecutive_failures: 0,
    },
    { onConflict: "tenant_id,company" }
  );
  if (error) {
    return { error: `Could not track "${company}" — ${error.message}` };
  }

  // Metered for the same reason checkCompanyNow is: tracking a company runs a
  // full crawl immediately, and an unmetered one bills the platform key.
  const actor = await requireActor();
  const budget = await withBudget({
    action: "crawl-on-track",
    estimateCents: 10,
    isAdmin: actor.isAdmin,
    fn: () => crawlCompany(company),
  });

  // The company IS now tracked — the write above succeeded — so a refused crawl
  // is reported as an outcome rather than as a failure to track. Saying "could
  // not track" here would send the user to re-add a company that is already on
  // their watchlist.
  if (budget.capped !== undefined) return { outcome: refusedCrawl(company, budget.capped) };
  if (budget.error !== undefined) {
    return {
      outcome: refusedCrawl(company, describeWriteFailure(budget.error, "crawl that company") ?? UNDESCRIBED_DB_ERROR),
    };
  }
  return { outcome: budget.result! };
}

// setTracking, markChecked, setCareersUrl, and removeFromWatchlist all
// filter their write with .eq("company", ...). lib/supabase.ts's query
// builder returns { error: null } no matter how many rows an UPDATE/DELETE
// matched (execute() only ever checks the driver-level error, never
// res.rowCount), so a company name that doesn't resolve to a stored row used
// to succeed silently while touching nothing — the caller saw no error, and
// Discover's handleWatch, for instance, would flip its "Watching" star off
// even though the underlying row was never touched. resolveWriteTarget
// (above) closes that: it checks existence up front and returns an explicit
// error naming the company instead of letting a guaranteed-zero-row write
// report success.

export async function setTracking(
  company: string,
  enabled: boolean
): Promise<{ error?: string }> {
  // Session required. Server Actions are RPC endpoints addressed by an ID that
  // ships in the client bundle, so a page-level check does not cover them.
  await requireActor();
  // Only when turning tracking ON. Untracking must always be allowed — a tenant
  // at their quota would otherwise be unable to free a slot, which turns a limit
  // into a trap.
  if (enabled) {
    const blocked = await quotaBlocks();
    if (blocked) return { error: blocked };
  }
  const target = await resolveWriteTarget(company);
  if (target.error) return { error: target.error };
  const patch: Record<string, unknown> = { tracking_enabled: enabled };
  if (enabled) patch.consecutive_failures = 0;
  // Cleared whichever way the switch went. Turning tracking ON restarts from a
  // clean slate; turning it OFF by hand must not leave the row looking like one
  // the crawler dropped, because the Watchlist tells those two apart by exactly
  // this column.
  patch.failing_since = null;
  const { error } = await supabase.forTenant(await resolveTenantId())
    .from("watchlist")
    .update(patch)
    .eq("company", target.company);
  return { error: error?.message };
}

export async function setCareersUrl(
  company: string,
  url: string
): Promise<{ error?: string }> {
  // Session required. Server Actions are RPC endpoints addressed by an ID that
  // ships in the client bundle, so a page-level check does not cover them.
  await requireActor();
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return { error: "Enter a full URL starting with http:// or https://" };
  }
  const target = await resolveWriteTarget(company);
  if (target.error) return { error: target.error };
  const { error } = await supabase.forTenant(await resolveTenantId())
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
    .eq("company", target.company);
  return { error: error?.message };
}

/**
 * A crawl costs the same whether a schedule asked for it or a person did, so it
 * is metered the same way.
 *
 * This was UNMETERED, and the consequence was not a missing statistic. With no
 * ambient scope, `routing()` in lib/model-call.ts falls back to
 * `process.env.ANTHROPIC_API_KEY` — the PLATFORM key — with `maxSearches: null`,
 * so any approved tenant could spend the owner's money, uncapped and unrecorded,
 * by clicking "Check now". The nightly path through app/api/cron/crawl was
 * wrapped; this one, which a person triggers, was not. A search-tier crawl is
 * 60-120 seconds of billed web searches.
 *
 * The same defect app/actions/parse-role.ts documents having already shipped
 * once, on a path that fix did not reach.
 *
 * `estimateCents: 10` matches the per-company figure the cron route uses
 * (`10 * slice.limit` for a batch).
 */
export async function checkCompanyNow(company: string): Promise<CrawlOutcome> {
  // Session required. Server Actions are RPC endpoints addressed by an ID that
  // ships in the client bundle, so a page-level check does not cover them.
  const actor = await requireActor();

  const budget = await withBudget({
    action: "crawl-now",
    estimateCents: 10,
    isAdmin: actor.isAdmin,
    fn: () => crawlCompany(company),
  });

  // Presence, not truthiness: `error` can be an empty string, and a capped
  // refusal is a sentence rather than a failure. Both surface through
  // CrawlOutcome's own error channel so the Watchlist renders them where it
  // already renders a failed crawl.
  if (budget.capped !== undefined) return refusedCrawl(company, budget.capped);
  if (budget.error !== undefined) {
    return refusedCrawl(company, describeWriteFailure(budget.error, "check that company") ?? UNDESCRIBED_DB_ERROR);
  }
  return budget.result!;
}

/** A crawl that never ran, shaped so the existing UI renders the reason. */
function refusedCrawl(company: string, error: string): CrawlOutcome {
  return { company, method: null, rolesFound: 0, newRoles: 0, status: "error", error };
}

export async function getDueCompanies(
  limit: number = DEFAULT_BATCH_LIMIT
): Promise<{ companies: string[]; error?: string }> {
  const { data, error } = await rawQuery<{ company: string }>(DUE_COMPANIES_SQL,
    [limit, await resolveTenantId()],
    await resolveTenantId()
  );
  if (error) return { companies: [], error: error.message };
  return { companies: (data ?? []).map((r) => r.company) };
}

/**
 * This tenant's single next crawl, and how much they have already had.
 *
 * The one-company-per-request loop (app/api/cron/crawl-next) asks every tenant
 * this and then chooses between the answers in application code — see
 * lib/crawl-next.ts for why the obvious cross-tenant query cannot be written
 * against RLS.
 *
 * `crawlsToday` counts from a FIXED UTC midnight rather than a rolling 24 hours.
 * Rolling is smoother and buys nothing at these volumes, while fixed is what a
 * user can be told ("three checks a day") and what a test can pin without
 * freezing a clock.
 */
export async function getCrawlCandidate(): Promise<{
  company: string | null;
  lastCheckedAt: string | null;
  crawlsToday: number;
  error?: string;
}> {
  const tenantId = await resolveTenantId();

  const { data: due, error: dueError } = await rawQuery<{
    company: string;
    last_checked_at: string | null;
  }>(DUE_COMPANIES_SQL, [1, tenantId], tenantId);
  if (dueError) {
    return { company: null, lastCheckedAt: null, crawlsToday: 0, error: dueError.message };
  }

  const { data: counted, error: countError } = await rawQuery<{ n: string }>(
    `select count(*) n from watchlist
      where tenant_id = $1
        and last_checked_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'`,
    [tenantId],
    tenantId
  );
  if (countError) {
    return { company: null, lastCheckedAt: null, crawlsToday: 0, error: countError.message };
  }

  const row = due[0];
  return {
    company: row?.company ?? null,
    lastCheckedAt: row?.last_checked_at ?? null,
    crawlsToday: Number(counted[0]?.n ?? 0),
  };
}

/**
 * How often this company is crawled, in days.
 *
 * The scheduler already honours a per-company interval — DUE_COMPANIES_SQL
 * computes due-ness from `crawl_interval_days` on each row, and the Watchlist
 * already renders the next check from it. Every company simply sat on the
 * default of 7 because nothing could set it. This is that missing control.
 *
 * Bounded rather than free-form. Below 1 the interval arithmetic in
 * DUE_COMPANIES_SQL makes a company due on every single run, which at 3 crawls a
 * night means one company would consume the entire platform batch and starve
 * every other company and tenant — a per-company setting quietly becoming a
 * platform-wide one. Above 365 it stops being a schedule.
 */
export async function setCrawlInterval(
  company: string,
  days: number
): Promise<{ error?: string }> {
  // Session required. Server Actions are RPC endpoints addressed by an ID that
  // ships in the client bundle, so a page-level check does not cover them.
  await requireActor();

  // Validated here, not only in the form: this is an RPC endpoint, and a value
  // that only the UI rejects is a value an action still accepts.
  const invalid = crawlIntervalError(days);
  if (invalid) return { error: invalid };

  const target = await resolveWriteTarget(company);
  if (target.error) return { error: target.error };

  const { error } = await supabase.forTenant(await resolveTenantId())
    .from("watchlist")
    .update({ crawl_interval_days: days })
    .eq("company", target.company);
  return { error: error?.message };
}
