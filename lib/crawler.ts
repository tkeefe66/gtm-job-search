import { callStructured, callWithWebSearch, parseJson } from "@/lib/anthropic";
import { resolveTenantId } from "@/lib/tenant";
import { ingestRoles } from "@/lib/ingest-roles";
import { isJsShell, stripHtml, type ExtractedPage } from "@/lib/page-extract";
import { isDisallowed, robotsUrlFor } from "@/lib/robots";
import { normalizeTitle } from "@/lib/role-key";
import type { FitInputs } from "@/lib/fit-inputs";
import {
  ROLE_SEARCH_SYSTEM,
  loadCriteriaAndScoringInputs,
  roleExtractionSchema,
  titleListForPrompt,
  type Criteria,
} from "@/lib/search-criteria";
import { readCriteriaChangedAt } from "@/lib/settings-store";
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

/**
 * Everything a crawl run needs from settings, resolved once and passed down.
 *
 * Bundled as one object rather than three sibling parameters because the
 * companion compensation plan adds a field here and no signature reopens.
 * The cron route builds it ONCE before its batch loop and hands the same
 * object to every iteration: a settings save landing mid-batch must not split
 * one run across two title lists.
 */
export interface RunContext {
  criteria: Criteria;
  fitInputs: FitInputs;
  criteriaChangedAt: string | null;
}

/**
 * Resolves a RunContext from the database. One settings read (inside
 * loadCriteriaAndScoringInputs) plus one timestamp read — the criteria and the
 * fit inputs come off the SAME snapshot rather than two, so a save landing
 * between them cannot crawl one title list and score against another floor.
 */
export async function loadRunContext(): Promise<RunContext> {
  const [{ criteria, fitInputs }, criteriaChangedAt] = await Promise.all([
    loadCriteriaAndScoringInputs(),
    readCriteriaChangedAt(),
  ]);
  return { criteria, fitInputs, criteriaChangedAt };
}

export function buildExtractionPrompt(
  company: string,
  page: ExtractedPage,
  criteria: Criteria
): string {
  const links = page.links
    .map((l) => `${l.text || "(no text)"} -> ${l.href}`)
    .join("\n");

  return `Below is the text and link list scraped from the careers page of "${company}".

Identify every open role matching any of these titles or close variants: ${titleListForPrompt(criteria)}.

${criteria.locationRule}

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
 * `runs` is [currentRunTitles, previousTrustworthyRunTitles]. A role closes
 * only when it is absent from BOTH — that is, two consecutive runs that each
 * produced a trustworthy "here's what's currently listed" signal did not
 * list it. Passing fewer than two runs closes nothing, so a company's first
 * trustworthy crawl never closes anything, and a role discovered today
 * (present in the current run) is never closed on the same day it was found.
 *
 * A run counts as trustworthy — and only ever appears in `runs` — when its
 * status is 'ok' (roles found) or 'empty' (page fetched/searched
 * successfully, genuinely zero matches; ruling 2026-08-12, see
 * closeStalePostings and spec §3.3 — empty is not a failure, and excluding
 * it meant the single most common real case, a company taking down its last
 * remaining posting, never closed anything). 'error' and 'needs_url' runs
 * are never passed in: a fetch failure must not close a live job.
 *
 * runsEligibleForClosure below extends the same principle one step further:
 * a run from before the user last edited the search criteria was looking for
 * a different title list, so it is also not evidence, and is filtered out
 * before it ever reaches this function.
 */
export function titlesToClose(runs: string[][], activeTitles: string[]): string[] {
  if (runs.length < 2) return [];
  const stillListed = new Set(runs.flat());
  return activeTitles.filter((t) => !stillListed.has(t));
}

/** One past crawl run, as closure evidence: when it finished, what it saw. */
export interface ClosureRun {
  finished_at: string;
  titles: string[];
}

/**
 * Which past crawl runs may be used as evidence that a posting is gone.
 *
 * titlesToClose already refuses to close on 'error' or 'needs_url' runs,
 * because a fetch failure is not evidence a job vanished. Editing the title
 * list is the same class of non-evidence: the crawler simply stopped looking
 * for that title, so its absence from a later run says nothing about whether
 * the posting is still up. Runs from before the change are therefore dropped,
 * which pushes the count under titlesToClose's two-run minimum and closes
 * nothing until two clean runs have happened under the current criteria.
 *
 * A run exactly at the change timestamp is excluded: it may have been in
 * flight when the save landed.
 */
export function runsEligibleForClosure(
  runs: ClosureRun[],
  criteriaChangedAt: string | null
): ClosureRun[] {
  if (!criteriaChangedAt) return runs;
  const cutoff = Date.parse(criteriaChangedAt);
  if (Number.isNaN(cutoff)) return runs;
  return runs.filter((r) => {
    const at = Date.parse(r.finished_at);
    if (Number.isNaN(at)) {
      // A nullable/unfinalized finished_at must not silently count as evidence.
      console.warn(
        `runsEligibleForClosure: run with unparseable finished_at "${r.finished_at}" excluded`
      );
      return false;
    }
    return at > cutoff;
  });
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
    // Search narration counts against the budget; 1500 risked the same
    // truncation-before-JSON failure mode documented on extractViaSearch's
    // call, silently degrading to needs_url even when a URL was found.
    maxTokens: 4000,
  });
  try {
    const parsed = parseJson<{ careers_url: string }>(raw);
    return parsed.careers_url?.trim() || null;
  } catch {
    return null;
  }
}

// Exported for testing: pure function of a raw model response string, no
// network involved, so the parse-failure logging (fix 7, 2026-08-12
// consolidated wave) can be pinned directly.
export function rolesFromRaw(raw: string): Role[] {
  let parsed: Role[] | RolesResult;
  try {
    parsed = parseJson<Role[] | RolesResult>(raw);
  } catch (err) {
    // parseJson throwing straight through here left this failure mode with
    // no diagnostic trail — err.message alone doesn't say what the model
    // actually returned. Truncation-before-JSON is a failure this codebase
    // has already hit once (see the maxTokens comment on extractViaSearch's
    // call); log enough of the raw response to tell that case apart from a
    // genuinely malformed one, then let the caller's existing error handling
    // (crawlCompany's try/catch → status "error") take over.
    console.error(
      `crawler: failed to parse roles JSON — ${err instanceof Error ? err.message : String(err)}. ` +
        `Raw response (first 500 chars): ${raw.slice(0, 500)}`
    );
    throw err;
  }
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
  careersUrl: string,
  criteria: Criteria
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
    prompt: buildExtractionPrompt(company, classification.page, criteria),
    maxTokens: 4000,
  });
  return { kind: "roles", roles: rolesFromRaw(raw) };
}

async function extractViaSearch(
  company: string,
  careersUrl: string | null,
  criteria: Criteria
): Promise<Role[]> {
  const hint = careersUrl ? ` Their careers page may be: ${careersUrl}.` : "";
  const raw = await callWithWebSearch({
    system: ROLE_SEARCH_SYSTEM,
    prompt: `Search for open go-to-market and revenue operations roles at "${company}".${hint} Look for these titles: ${titleListForPrompt(criteria)}. Visit each job posting URL if available to extract the full details. IMPORTANT location filter: ${criteria.locationRule}

${roleExtractionSchema()}

If no qualifying roles are found, return a JSON object: {"roles": [], "message": "explanation"}. Otherwise return ONLY the JSON array.`,
    // Search narration counts against the budget; 2000 has truncated the
    // response before the JSON was emitted.
    maxTokens: 8000,
  });
  return rolesFromRaw(raw);
}

// Exported (rather than inlined) so the 'ok'/'empty' scoping — the whole
// point of fix 2 in the 2026-08-12 consolidated wave — can be pinned by a
// string-content test without a database, same pattern as
// STALE_POSTING_CANDIDATES_SQL below. 'error' and 'needs_url' must never
// appear here: a fetch failure is not evidence a role is gone.
// finished_at is selected alongside role_titles because runsEligibleForClosure
// dates each run against the criteria-change stamp. rawQuery's row type is an
// assertion rather than something inferred from this string, so dropping the
// column compiles clean and silently disables closure — hence the string test.
export const LAST_TRUSTWORTHY_RUN_SQL = `select role_titles, finished_at from crawl_runs
      where tenant_id = $2 and company = $1 and status in ('ok', 'empty')
      order by started_at desc
      limit 1`;

/** A crawl_runs row as LAST_TRUSTWORTHY_RUN_SQL returns it. */
export interface TrustworthyRunRow {
  role_titles: string[] | null;
  finished_at: string | null;
}

/**
 * Maps crawl_runs rows onto closure evidence.
 *
 * Exported only so it can be tested without a database, and it is worth
 * testing because it is the last link in the finished_at chain: the SQL
 * selecting the column and runsEligibleForClosure reading it are both pinned,
 * but a mapper that quietly failed to carry finished_at across would leave
 * every previous run unparseable — dropped, closure disabled after the first
 * criteria edit, no error anywhere.
 */
export function closureRunsFromRows(rows: TrustworthyRunRow[]): ClosureRun[] {
  return rows.map((r) => ({
    finished_at: r.finished_at as string,
    titles: r.role_titles ?? [],
  }));
}

/**
 * The single most recent run that produced a trustworthy "here's what's
 * currently listed" signal (status 'ok' or 'empty'), or [] if there is none.
 */
async function lastSuccessfulTitles(company: string): Promise<ClosureRun[]> {
  const { data } = await rawQuery<TrustworthyRunRow>(LAST_TRUSTWORTHY_RUN_SQL,
    [company, await resolveTenantId()],
    await resolveTenantId()
  );
  return closureRunsFromRows(data ?? []);
}

// The crawler may only retract its OWN findings that the user has never
// acted on. Both predicates are load-bearing — do not "simplify" either
// away:
//   - source = 'Crawl': a crawl only looks for target titles on one careers
//     page, so jobs added by Find Roles, recruiter parsing, or manual entry
//     are absent from seenTitles BY CONSTRUCTION, not because they're
//     actually gone. Without this predicate they would be closed on the
//     very next crawl of this company, deterministically. (ingestRoles sets
//     `source` from its `source` option; the crawler always passes "Crawl".)
//   - status = 'New': there is no history table and updateJob writes in
//     place, so overwriting status is irreversible. A job the user has
//     moved to Applied, Panel Interviews, Offer, etc. is theirs — no
//     automated process may touch it, even if its posting comes down.
//     Accepted consequence: a crawler-found role the user applied to stays
//     visible after the listing disappears, until closed by hand. That is
//     deliberate — a stale row costs a glance, a lost pipeline stage costs
//     unrecoverable information.
// Exported (rather than inlined in the query call) so the scoping decision
// can be pinned by a string-content test without a database.
export const STALE_POSTING_CANDIDATES_SQL = `select id, role_title from jobs
      where tenant_id = $2
        and company = $1
        and source = 'Crawl'
        and status = 'New'`;

/**
 * The title lists titlesToClose is allowed to weigh, with any run predating
 * the last criteria change removed.
 *
 * Exported and lifted out of closeStalePostings (which needs a database) for
 * one specific reason: the whole gate is expressed as *which array gets
 * mapped*, and writing `runs.map(...)` where `eligible.map(...)` belongs
 * compiles, type-checks, passes every runsEligibleForClosure test, and quietly
 * reinstates the exact auto-closure bug this task exists to prevent. Out here
 * that mutation is a one-line test instead of an untestable seam.
 *
 * The cutoff arrives as `Pick<RunContext, "criteriaChangedAt">`, not a bare
 * `string | null`, for the same reason closeStalePostings takes the whole
 * RunContext: a literal `null` in this argument position disables the gate and
 * would otherwise type-check. Sealing only the caller left this use site open.
 */
export function closureEvidenceTitles(
  company: string,
  runs: ClosureRun[],
  ctx: Pick<RunContext, "criteriaChangedAt">
): string[][] {
  const eligible = runsEligibleForClosure(runs, ctx.criteriaChangedAt);
  if (eligible.length < runs.length) {
    console.log(
      `closureEvidenceTitles(${company}): ${runs.length - eligible.length} run(s) predate ` +
        `the last criteria change and were excluded from closure evidence`
    );
  }
  return eligible.map((r) => r.titles);
}

// Takes the whole RunContext rather than a bare `string | null` on purpose:
// `closeStalePostings(company, runs, null)` would otherwise type-check, and
// silently passing null here disables the criteria gate — the one thing this
// function exists to enforce. Requiring the context makes that a deliberate
// object literal instead of a plausible-looking argument.
async function closeStalePostings(
  company: string,
  runs: ClosureRun[],
  ctx: RunContext
): Promise<void> {
  const { data } = await rawQuery<{ id: string; role_title: string }>(
    STALE_POSTING_CANDIDATES_SQL,
    [company, await resolveTenantId()],
    await resolveTenantId()
  );

  const active = (data ?? []).map((r) => ({
    id: r.id,
    key: normalizeTitle(r.role_title),
  }));
  const toClose = titlesToClose(
    closureEvidenceTitles(company, runs, ctx),
    active.map((a) => a.key)
  );
  if (toClose.length === 0) return;

  const closing = new Set(toClose);
  for (const job of active) {
    if (!closing.has(job.key)) continue;
    const { error: closeError } = await supabase.forTenant(await resolveTenantId())
      .from("jobs")
      .update({ status: "Posting Closed", updated_at: new Date().toISOString() })
      .eq("id", job.id);
    // The update's result was previously discarded, so a failed write still
    // logged "closed stale posting" as though it had succeeded. Log the
    // truth instead.
    if (closeError) {
      console.error(
        `crawler: failed to close stale posting ${company} / ${job.key} — ${closeError.message}`
      );
    } else {
      console.log(`crawler: closed stale posting ${company} / ${job.key}`);
    }
  }
}

/**
 * `opts.ctx` is the batch escape hatch: the cron route resolves settings once
 * and passes the same RunContext into every company, so one batch is crawled
 * against one consistent set of criteria (and pays for one settings read, not
 * one per company). The two single-company callers in app/actions/watchlist.ts
 * omit it and get a freshly-loaded context, which is what makes "save the
 * settings, then hit Check now" reflect the edit immediately.
 */
export async function crawlCompany(
  company: string,
  opts: { dryRun?: boolean; ctx?: RunContext } = {}
): Promise<CrawlOutcome> {
  const dryRun = opts.dryRun ?? false;
  const ctx = opts.ctx ?? (await loadRunContext());

  const { data: row, error: watchlistReadError } = await supabase.forTenant(await resolveTenantId())
    .from("watchlist")
    .select("*")
    .eq("company", company)
    .maybeSingle();
  if (watchlistReadError) {
    console.error(
      `crawler: ${company} failed to read watchlist row — ${watchlistReadError.message}`
    );
  }

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
    const { data: runRows, error: crawlRunInsertError } = await supabase.forTenant(await resolveTenantId())
      .from("crawl_runs")
      .insert({ company, status: "running" })
      .select()
      .single();
    if (crawlRunInsertError) {
      console.error(
        `crawler: ${company} failed to insert the crawl_runs row — ${crawlRunInsertError.message}`
      );
    }
    runId = (runRows as { id: string } | null)?.id ?? null;
  }

  // Two different questions share this scope and must not be conflated:
  // runMethod is "which tier actually ran this run" (used for crawl_runs.method
  // and the returned CrawlOutcome — needs to be accurate even in the steady
  // state where a 'search'-pinned company skips the fetch attempt entirely).
  // learnedMethod is "what should be persisted to watchlist.crawl_method" —
  // only ever a STABLE page property ('search' from a confirmed shell), never
  // set from a transient fetch-tier failure. It is passed as coalesce($2, ...)
  // so leaving it null preserves whatever crawl_method already was.
  let runMethod: CrawlMethod | null = null;
  let learnedMethod: CrawlMethod | null = null;
  let status: CrawlStatus = "error";
  let errorMessage: string | undefined;
  let roles: Role[] = [];
  let newRoles = 0;
  let seenTitles: string[] = [];

  try {
    let careersUrl = tracked.careers_url;
    if (!careersUrl) {
      careersUrl = await resolveCareersUrl(company);
      // A dry run previews a crawl; it must not permanently write a
      // model-guessed careers_url the user never reviewed.
      if (careersUrl && !dryRun) {
        const { error: careersUrlError } = await supabase.forTenant(await resolveTenantId())
          .from("watchlist")
          .update({ careers_url: careersUrl })
          .eq("company", company);
        if (careersUrlError) {
          console.error(
            `crawler: ${company} failed to persist resolved careers_url — ${careersUrlError.message}`
          );
        }
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
        fetchResult = await extractViaFetch(company, careersUrl, ctx.criteria);
      }

      if (fetchResult?.kind === "roles") {
        runMethod = "fetch";
        learnedMethod = "fetch";
        roles = fetchResult.roles;
      } else {
        // "shell" is a stable property of the page — learn 'search' so
        // future runs skip the fetch attempt. "unavailable" (robots block,
        // network error, timeout, non-2xx) is transient: learnedMethod stays
        // null, and coalesce($2, crawl_method) in the watchlist update below
        // then preserves whatever crawl_method already was, so the next run
        // retries the fetch tier instead of being stuck on search forever.
        // runMethod is "search" unconditionally here — the search tier is
        // what actually ran, whether or not this run taught us anything new.
        learnedMethod = fetchResult?.kind === "shell" ? "search" : null;
        runMethod = "search";
        roles = await extractViaSearch(company, careersUrl, ctx.criteria);
      }

      // Read the previous trustworthy run BEFORE this run's row is finalized.
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
        fitInputs: ctx.fitInputs,
      });

      newRoles = result.added.length;
      seenTitles = result.seenTitles;
      status = roles.length > 0 ? "ok" : "empty";

      // Ruling 2026-08-12: empty crawls may close too, not just 'ok' ones —
      // a company taking down its last remaining posting is the most common
      // real case, and excluding 'empty' meant it never closed. 'error' and
      // 'needs_url' still never reach this branch at all (status is only
      // ever "ok" or "empty" here, set two lines above from roles.length) —
      // that's the safety property, and it holds structurally, not just by
      // this check: a fetch failure must never close a live job.
      if (!dryRun) {
        // [current run, previous trustworthy run] — a role closes only when
        // absent from both, so nothing found today is ever closed today.
        //
        // The current run's crawl_runs row is not finalized until after this
        // block, so it has no finished_at to read back. Stamping "now" here is
        // deliberate and correct: the run IS finishing, and leaving it
        // null/undefined would make runsEligibleForClosure drop the current
        // run as unparseable, permanently disabling closure after the first
        // criteria edit.
        await closeStalePostings(
          company,
          [{ finished_at: new Date().toISOString(), titles: seenTitles }, ...previousRun],
          ctx
        );
      }
    }
  } catch (err) {
    status = "error";
    errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`crawler: ${company} failed — ${errorMessage}`);
  }

  if (!dryRun) {
    if (runId) {
      const { error: crawlRunUpdateError } = await supabase.forTenant(await resolveTenantId())
        .from("crawl_runs")
        .update({
          finished_at: new Date().toISOString(),
          method: runMethod,
          roles_found: roles.length,
          new_roles: newRoles,
          role_titles: seenTitles,
          status,
          error: errorMessage ?? null,
        })
        .eq("id", runId);
      if (crawlRunUpdateError) {
        console.error(
          `crawler: ${company} failed to finalize crawl_runs row ${runId} — ${crawlRunUpdateError.message}`
        );
      }
    }

    const failed = status === "error" || status === "needs_url";
    const { error: watchlistUpdateError } = await rawQuery(
      `update watchlist
          set last_checked_at = now(),
              crawl_method = coalesce($2, crawl_method),
              last_crawl_status = $3,
              last_crawl_error = $4,
              consecutive_failures = case when $5 then consecutive_failures + 1 else 0 end
        where company = $1 and tenant_id = $6`,
      [company, learnedMethod, status, errorMessage ?? null, failed, await resolveTenantId()],
      await resolveTenantId()
    );
    if (watchlistUpdateError) {
      // last_checked_at did not advance, so the batch scheduler will see this
      // company as still due and may re-crawl (and re-bill ~10 searches for
      // it) on the very next pass. Downgrading to "error" here is what lets
      // the caller notice the run was not actually recorded, instead of
      // silently repeating.
      const priorStatus = status;
      console.error(
        `crawler: ${company} failed to update watchlist after crawl — ${watchlistUpdateError.message}`
      );
      status = "error";
      errorMessage = errorMessage
        ? `${errorMessage} (also failed to record the crawl on the watchlist: ${watchlistUpdateError.message})`
        : `Crawl finished as "${priorStatus}" but the watchlist record could not be updated — ${watchlistUpdateError.message}. last_checked_at was not advanced; this company may be re-crawled prematurely.`;
    }
  }

  return {
    company,
    method: runMethod,
    rolesFound: roles.length,
    newRoles,
    status,
    error: errorMessage,
  };
}
