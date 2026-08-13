import { callStructured, callWithWebSearch, parseJson } from "@/lib/anthropic";
import { ingestRoles } from "@/lib/ingest-roles";
import { isJsShell, stripHtml, type ExtractedPage } from "@/lib/page-extract";
import { isDisallowed, robotsUrlFor } from "@/lib/robots";
import { normalizeTitle } from "@/lib/role-key";
import {
  LOCATION_RULE,
  ROLE_SEARCH_SYSTEM,
  roleExtractionSchema,
  titleListForPrompt,
} from "@/lib/search-criteria";
import { rawQuery, supabase } from "@/lib/supabase";
import type {
  CrawlMethod,
  CrawlStatus,
  Role,
  RolesResult,
  TrackedCompany,
} from "@/lib/types";

const FETCH_TIMEOUT_MS = 10_000;
const USER_AGENT =
  "GTMJobSearchBot/1.0 (personal job-search tool; contact tkeefe66@gmail.com)";

export interface CrawlOutcome {
  company: string;
  method: CrawlMethod | null;
  rolesFound: number;
  newRoles: number;
  status: CrawlStatus;
  error?: string;
}

export function buildExtractionPrompt(
  company: string,
  page: ExtractedPage
): string {
  const links = page.links
    .map((l) => `${l.text || "(no text)"} -> ${l.href}`)
    .join("\n");

  return `Below is the text and link list scraped from the careers page of "${company}".

Identify every open role matching any of these titles or close variants: ${titleListForPrompt()}.

${LOCATION_RULE}

${roleExtractionSchema()}

Use the link list to fill job_url — resolve relative URLs against the careers page where you can, otherwise return the relative path as-is. If no role on the page qualifies, return exactly [] and nothing else. Return ONLY the JSON array.

--- PAGE TEXT ---
${page.text}

--- LINKS ---
${links}`;
}

/**
 * Which previously-seen roles should be marked Posting Closed.
 *
 * `runs` is [currentRunTitles, previousSuccessfulRunTitles]. A role closes
 * only when it is absent from BOTH — that is, two consecutive successful
 * crawls did not list it. Passing fewer than two runs closes nothing, so a
 * company's first successful crawl never closes anything, and a role
 * discovered today (present in the current run) is never closed on the same
 * day it was found.
 *
 * Failed, empty, and needs_url runs are never passed in: a fetch failure must
 * not close a live job.
 */
export function titlesToClose(runs: string[][], activeTitles: string[]): string[] {
  if (runs.length < 2) return [];
  const stillListed = new Set(runs.flat());
  return activeTitles.filter((t) => !stillListed.has(t));
}

async function fetchPage(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT },
    });
    if (!res.ok) {
      console.warn(`crawler: fetch of ${url} returned ${res.status}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    console.warn(
      `crawler: fetch of ${url} failed — ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveCareersUrl(company: string): Promise<string | null> {
  const raw = await callWithWebSearch({
    system:
      "You find official careers pages. Return ONLY valid JSON, no markdown, no preamble.",
    prompt: `Find the official careers / open-roles page for the company "${company}". Return a JSON object: {"careers_url": "https://..."} — or {"careers_url": ""} if you cannot find one with confidence.`,
    maxTokens: 1500,
  });
  try {
    const parsed = parseJson<{ careers_url: string }>(raw);
    return parsed.careers_url?.trim() || null;
  } catch {
    return null;
  }
}

function rolesFromRaw(raw: string): Role[] {
  const parsed = parseJson<Role[] | RolesResult>(raw);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object" && "roles" in parsed) {
    return parsed.roles ?? [];
  }
  return [];
}

// Three-way outcome of fetching robots.txt itself, kept distinct from what
// fetchPage returns (which flattens "absent" and "errored" to the same
// null). A 404/410 means the site simply doesn't publish one — that's a
// normal, well-formed "allowed" signal. A network error, timeout, or 5xx
// means we could not read the rules at all, which is not the same thing and
// must not be treated as permission.
type RobotsFetch =
  | { kind: "ok"; body: string }
  | { kind: "absent" }
  | { kind: "error" };

async function fetchRobotsTxt(url: string): Promise<RobotsFetch> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT },
    });
    if (res.status === 404 || res.status === 410) {
      return { kind: "absent" };
    }
    if (!res.ok) {
      console.warn(`crawler: robots.txt fetch of ${url} returned ${res.status}`);
      return { kind: "error" };
    }
    return { kind: "ok", body: await res.text() };
  } catch (err) {
    console.warn(
      `crawler: robots.txt fetch of ${url} failed — ${err instanceof Error ? err.message : String(err)}`
    );
    return { kind: "error" };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAllowed(careersUrl: string): Promise<boolean> {
  const result = await fetchRobotsTxt(robotsUrlFor(careersUrl));
  if (result.kind === "absent") return true; // no robots.txt served — allowed
  if (result.kind === "error") return false; // could not read the rules — don't guess
  return !isDisallowed(result.body, new URL(careersUrl).pathname);
}

/**
 * Classifies an already-fetched (or not-fetched) careers page as a STABLE
 * property of the page ("shell" — HTML genuinely has no jobs, won't change
 * next run) or "content" (worth extracting from). `html === null` means the
 * fetch never produced a page at all — that classification is left to the
 * caller, which also knows about the transient robots/network cases; this
 * function only decides the pure, page-content question. Exported for
 * testing without a network: it takes plain HTML in, no fetch involved.
 */
export type FetchClassification =
  | { kind: "shell" }
  | { kind: "content"; page: ExtractedPage };

export function classifyFetchOutcome(html: string): FetchClassification {
  const page = stripHtml(html);
  return isJsShell(page) ? { kind: "shell" } : { kind: "content", page };
}

/**
 * Result of attempting the fetch tier. `crawl_method` should only ever be
 * set from "roles" or "shell" — both are stable properties of the page (it
 * worked, or the HTML genuinely has no jobs) that will hold true next run
 * too. "unavailable" covers everything transient — robots.txt disallowed
 * (including a robots.txt that could not be read at all), a network error,
 * a timeout, or a non-2xx response — and must NOT be learned, or a single
 * blip permanently pins the company to the ~10-billed-search path.
 */
type FetchTierResult =
  | { kind: "roles"; roles: Role[] }
  | { kind: "shell" }
  | { kind: "unavailable" };

async function extractViaFetch(
  company: string,
  careersUrl: string
): Promise<FetchTierResult> {
  if (!(await fetchAllowed(careersUrl))) {
    console.log(
      `crawler: robots.txt disallows (or could not be read for) ${careersUrl}, using search tier for this run`
    );
    return { kind: "unavailable" };
  }

  const html = await fetchPage(careersUrl);
  if (!html) return { kind: "unavailable" };

  const classification = classifyFetchOutcome(html);
  if (classification.kind === "shell") {
    console.log(`crawler: ${company} careers page is a JS shell, using search tier`);
    return { kind: "shell" };
  }

  const raw = await callStructured({
    system: ROLE_SEARCH_SYSTEM,
    prompt: buildExtractionPrompt(company, classification.page),
    maxTokens: 4000,
  });
  return { kind: "roles", roles: rolesFromRaw(raw) };
}

async function extractViaSearch(
  company: string,
  careersUrl: string | null
): Promise<Role[]> {
  const hint = careersUrl ? ` Their careers page may be: ${careersUrl}.` : "";
  const raw = await callWithWebSearch({
    system: ROLE_SEARCH_SYSTEM,
    prompt: `Search for open go-to-market and revenue operations roles at "${company}".${hint} Look for these titles: ${titleListForPrompt()}. Visit each job posting URL if available to extract the full details. IMPORTANT location filter: ${LOCATION_RULE}

${roleExtractionSchema()}

If no qualifying roles are found, return a JSON object: {"roles": [], "message": "explanation"}. Otherwise return ONLY the JSON array.`,
    // Search narration counts against the budget; 2000 has truncated the
    // response before the JSON was emitted.
    maxTokens: 8000,
  });
  return rolesFromRaw(raw);
}

/** Titles seen on the single most recent successful run, or [] if there is none. */
async function lastSuccessfulTitles(company: string): Promise<string[][]> {
  const { data } = await rawQuery<{ role_titles: string[] }>(
    `select role_titles from crawl_runs
      where company = $1 and status = 'ok'
      order by started_at desc
      limit 1`,
    [company]
  );
  return (data ?? []).map((r) => r.role_titles ?? []);
}

async function closeStalePostings(
  company: string,
  runs: string[][]
): Promise<void> {
  const { data } = await rawQuery<{ id: string; role_title: string }>(
    `select id, role_title from jobs
      where company = $1
        and status not in ('Posting Closed', 'Rejected', 'Not Interested', 'Passed')`,
    [company]
  );

  const active = (data ?? []).map((r) => ({
    id: r.id,
    key: normalizeTitle(r.role_title),
  }));
  const toClose = titlesToClose(
    runs,
    active.map((a) => a.key)
  );
  if (toClose.length === 0) return;

  const closing = new Set(toClose);
  for (const job of active) {
    if (!closing.has(job.key)) continue;
    await supabase
      .from("jobs")
      .update({ status: "Posting Closed", updated_at: new Date().toISOString() })
      .eq("id", job.id);
    console.log(`crawler: closed stale posting ${company} / ${job.key}`);
  }
}

export async function crawlCompany(
  company: string,
  opts: { dryRun?: boolean } = {}
): Promise<CrawlOutcome> {
  const dryRun = opts.dryRun ?? false;

  const { data: row } = await supabase
    .from("watchlist")
    .select("*")
    .eq("company", company)
    .maybeSingle();

  const tracked = row as TrackedCompany | null;
  if (!tracked) {
    return {
      company,
      method: null,
      rolesFound: 0,
      newRoles: 0,
      status: "error",
      error: `"${company}" is not on the watchlist. Track it before crawling.`,
    };
  }
  if (!tracked.tracking_enabled) {
    return {
      company,
      method: null,
      rolesFound: 0,
      newRoles: 0,
      status: "error",
      error: `Tracking is turned off for "${company}".`,
    };
  }

  // A dry run must write nothing at all — including the initial "running"
  // row, which would otherwise be inserted here and then never finalized
  // (the closing update below is itself dryRun-guarded), leaving a permanent
  // orphaned "running" row behind.
  let runId: string | null = null;
  if (!dryRun) {
    const { data: runRows } = await supabase
      .from("crawl_runs")
      .insert({ company, status: "running" })
      .select()
      .single();
    runId = (runRows as { id: string } | null)?.id ?? null;
  }

  let method: CrawlMethod | null = null;
  let status: CrawlStatus = "error";
  let errorMessage: string | undefined;
  let roles: Role[] = [];
  let newRoles = 0;
  let seenTitles: string[] = [];

  try {
    let careersUrl = tracked.careers_url;
    if (!careersUrl) {
      careersUrl = await resolveCareersUrl(company);
      if (careersUrl) {
        await supabase
          .from("watchlist")
          .update({ careers_url: careersUrl })
          .eq("company", company);
      }
    }

    if (!careersUrl) {
      status = "needs_url";
      errorMessage = `Could not find a careers page for "${company}". Add one manually on the Watchlist page.`;
    } else {
      // A company that previously needed the search tier skips the fetch
      // attempt. A 'fetch' company that now returns a shell re-learns 'search'.
      let fetchResult: FetchTierResult | null = null;
      if (tracked.crawl_method !== "search") {
        fetchResult = await extractViaFetch(company, careersUrl);
      }

      if (fetchResult?.kind === "roles") {
        method = "fetch";
        roles = fetchResult.roles;
      } else {
        // "shell" is a stable property of the page — learn 'search' so
        // future runs skip the fetch attempt. "unavailable" (robots block,
        // network error, timeout, non-2xx) is transient: method stays null,
        // and coalesce($2, crawl_method) in the watchlist update below then
        // preserves whatever crawl_method already was, so the next run
        // retries the fetch tier instead of being stuck on search forever.
        method = fetchResult?.kind === "shell" ? "search" : null;
        roles = await extractViaSearch(company, careersUrl);
      }

      // Read the previous successful run BEFORE this run's row is finalized.
      const previousRun = await lastSuccessfulTitles(company);

      const result = await ingestRoles({
        company,
        roles,
        companyContext: {
          tagline: tracked.tagline,
          traction: tracked.traction,
          careers_url: careersUrl,
          category: tracked.category,
          raised: tracked.raised,
          stage: tracked.stage,
        },
        source: "Crawl",
        dryRun,
      });

      newRoles = result.added.length;
      seenTitles = result.seenTitles;
      status = roles.length > 0 ? "ok" : "empty";

      if (!dryRun && status === "ok") {
        // [current run, previous successful run] — a role closes only when
        // absent from both, so nothing found today is ever closed today.
        await closeStalePostings(company, [seenTitles, ...previousRun]);
      }
    }
  } catch (err) {
    status = "error";
    errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`crawler: ${company} failed — ${errorMessage}`);
  }

  if (!dryRun) {
    if (runId) {
      await supabase
        .from("crawl_runs")
        .update({
          finished_at: new Date().toISOString(),
          method,
          roles_found: roles.length,
          new_roles: newRoles,
          role_titles: seenTitles,
          status,
          error: errorMessage ?? null,
        })
        .eq("id", runId);
    }

    const failed = status === "error" || status === "needs_url";
    await rawQuery(
      `update watchlist
          set last_checked_at = now(),
              crawl_method = coalesce($2, crawl_method),
              last_crawl_status = $3,
              last_crawl_error = $4,
              consecutive_failures = case when $5 then consecutive_failures + 1 else 0 end
        where company = $1`,
      [company, method, status, errorMessage ?? null, failed]
    );
  }

  return {
    company,
    method,
    rolesFound: roles.length,
    newRoles,
    status,
    error: errorMessage,
  };
}
