import { getJobStatuses } from "@/app/actions/jobs";
import { dispositionStatus } from "@/lib/job-dispositions";
import { ModelResponseError, assertModelComplete } from "./model-response";
import {
  callStructured,
  SpendLimitReachedError,
  SearchUnavailableError,
  callWithWebSearchDetailed,
  parseJson,
} from "@/lib/model-call";
import { resolveTenantId } from "@/lib/tenant";
import { buildCompanyRolePrompt } from "@/lib/company-role-prompt";
import { ingestRoles, refreshChangedCrawlRole, MAX_INGEST_READS } from "@/lib/ingest-roles";
import { isJsShell, stripHtml, MAX_PAGE_CHARS, type ExtractedPage } from "@/lib/page-extract";
import { fetchAllowed, fetchPage } from "@/lib/fetch-page";
import { CAREERS_PAGE_MAX_BYTES } from "./careers-page-limits";
import { rolesFromBoard } from "@/lib/board-source";
import { verifiedCompanyBoard } from "./employer-board-source";
import { candidatesToProcess, crawlProcessingQueue, carryListingAttempts, contentFingerprint, criteriaFingerprint, listingKey, pageFingerprint, type CrawlSnapshot, type ListingSnapshot } from "./crawl-snapshot";
import { readCrawlSnapshot, saveCrawlSnapshot, settledCrawlRoles } from "./crawl-snapshot-store";
import { billingScope } from "./billing-context";
import { paidSearchDecision, crawlPolicyOutcome, COMPANY_SEARCH_LIMIT, type CrawlTrigger } from "./crawl-policy";
import { withAIAttribution, aiAttribution } from "./ai-attribution";
import { describeWriteFailure } from "./write-failure";
import { arrayUnder, parseOrSalvage } from "@/lib/salvage-call";
import { ROLE_FIELDS } from "@/lib/types";
import { NORMALIZED_COMPANY_SQL, normalizeCompanyName, normalizeTitle } from "@/lib/role-key";
import type { FitInputs } from "@/lib/fit-inputs";
import type { Profile } from "@/lib/profile";
import {
  loadCriteriaAndScoringInputs,
  roleExtractionSchema,
  roleSearchSystem,
  titleListForPrompt,
  type Criteria,
} from "@/lib/search-criteria";
import { readCriteriaChangedAt } from "@/lib/settings-store";
import { rawQuery, supabase } from "@/lib/supabase";
import type {
  CrawlMethod,
  CrawlStatus,
  Role,
  TrackedCompany,
} from "@/lib/types";

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
  /** The tenant's career profile — every prompt fragment this run interpolates. */
  profile: Profile;
  criteriaChangedAt: string | null;
}

/**
 * Resolves a RunContext from the database. One settings read (inside
 * loadCriteriaAndScoringInputs) plus one timestamp read — the criteria, the
 * fit inputs, and the profile all come off the SAME snapshot rather than two
 * reads, so a save landing between them cannot crawl one title list, one
 * profile, and score against another floor.
 */
export async function loadRunContext(): Promise<RunContext> {
  const [{ criteria, fitInputs, profile }, criteriaChangedAt] = await Promise.all([
    loadCriteriaAndScoringInputs(),
    readCriteriaChangedAt(),
  ]);
  return { criteria, fitInputs, profile, criteriaChangedAt };
}

/**
 * The criteria a single company's crawl should actually run against.
 *
 * `locationRule` is a soft, model-obeyed instruction baked straight into the
 * search/extraction prompts (never a hard filter, and never seen by
 * scoreFit) — so a role can go unfound simply because the model honoured a
 * location constraint the tenant doesn't want applied to THIS company. The
 * override replaces it with an explicit any-location note rather than
 * omitting the line, so the model is told, not merely left silent.
 *
 * Pure and per-company: `ctx.criteria` is shared across an entire cron
 * batch (see RunContext's doc comment), so this must return a new object
 * rather than mutate it, or the override would leak into the next
 * company's crawl.
 */
export function criteriaForCompany(criteria: Criteria, ignoreLocation: boolean): Criteria {
  if (!ignoreLocation) return criteria;
  return {
    ...criteria,
    locationRule:
      "Location is not a filter for this company — include on-site, hybrid, and remote roles regardless of city.",
  };
}

// Download size is not model input size. Keep complete link lines within a
// separate allowance and mark omitted links as incomplete source evidence.
function extractionLinks(page: ExtractedPage): { text: string; complete: boolean } {
  const lines: string[] = [];
  let length = 0;
  for (const link of page.links) {
    const line = `${link.text || "(no text)"} -> ${link.href}`;
    const added = line.length + (lines.length ? 1 : 0);
    if (length + added > 20_000) return { text: lines.join("\n"), complete: false };
    lines.push(line);
    length += added;
  }
  return { text: lines.join("\n"), complete: true };
}

export function buildExtractionPrompt(
  company: string,
  page: ExtractedPage,
  criteria: Criteria,
  persona: string,
  buildingConcept: string,
  buildingUpside: string
): string {
  const links = extractionLinks(page).text;

  return `Below is the text and link list scraped from the careers page of "${company}".

Identify every open role matching any of these titles or close variants: ${titleListForPrompt(criteria)}.

${criteria.locationRule}

${roleExtractionSchema(persona, buildingConcept, buildingUpside)}

Use the link list to fill job_url — resolve relative URLs against the careers page where you can, otherwise return the relative path as-is. If no role on the page qualifies, return exactly [] and nothing else. Return ONLY the JSON array.

--- PAGE TEXT ---
${page.text.slice(0, MAX_PAGE_CHARS)}

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

async function resolveCareersUrl(company: string, maxSearches:number): Promise<string | null> {
  const response = await callWithWebSearchDetailed({
    system:
      "You find official careers pages. Return ONLY valid JSON, no markdown, no preamble.",
    prompt: `Find the official careers / open-roles page for the company "${company}". Return a JSON object: {"careers_url": "https://..."} — or {"careers_url": ""} if you cannot find one with confidence.`,
    // Search narration counts against the budget; 1500 risked the same
    // truncation-before-JSON failure mode documented on extractViaSearch's
    // call, silently degrading to needs_url even when a URL was found.
    maxTokens: 4000,
    maxSearches,
    searchMode:"filtered",
  });
  assertModelComplete(response.stopReason);
  try {
    const parsed = parseJson<{ careers_url: string }>(response.text);
    if (!parsed || typeof parsed.careers_url !== "string") throw new ModelResponseError();
    return parsed.careers_url.trim() || null;
  } catch {
    throw new ModelResponseError("The careers-page lookup returned an invalid answer. Please retry.");
  }
}

// Exported for testing: pure function of a raw model response string, no
// network involved, so the parse-failure logging (fix 7, 2026-08-12
// consolidated wave) can be pinned directly.
export function rolesFrom(parsed: unknown): { items: Role[]; message?: string } {
  return arrayUnder<Role>("roles", ["role_title"])(parsed);
}

export function rolesFromRaw(raw: string): Role[] {
  try { return rolesFrom(parseJson<unknown>(raw)).items; }
  catch (error) {
    console.error(`crawler: invalid roles response (${raw.length} characters)`);
    throw error;
  }
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
  | { kind: "roles"; roles: Role[]; snapshot:CrawlSnapshot|null; cached:boolean; complete:boolean }
  | { kind: "shell" }
  | { kind: "unavailable"; reason: string };

async function storedAtsLinks(company: string): Promise<string[]> {
  const tenantId = await resolveTenantId();
  const { data, error } = await rawQuery<{ job_url: string }>(
    `select job_url from jobs
      where tenant_id = $2 and ${NORMALIZED_COMPANY_SQL} = $1
        and job_url ~* '(greenhouse|ashby|lever|workable|breezy)'
      order by created_at desc limit 3`,
    [normalizeCompanyName(company), tenantId],
    tenantId
  );
  if (error) {
    console.warn(`crawler: could not read stored links for ${company} — ${error.message}`);
    return [];
  }
  return (data ?? []).map((r) => r.job_url);
}

async function extractViaFetch(
  company: string,
  careersUrl: string,
  criteria: Criteria,
  profile: Profile,
  criteriaHash:string,
  modelCall:<T>(fn:()=>Promise<T>)=>Promise<T>
): Promise<FetchTierResult> {
  if (!(await fetchAllowed(careersUrl))) {
    console.log(
      `crawler: robots.txt disallows (or could not be read for) ${careersUrl}, using search tier for this run`
    );
    return { kind: "unavailable", reason: "The site's automated-access rules blocked the direct check, or those rules could not be read." };
  }

  const html = await fetchPage(careersUrl, { maxBytes: CAREERS_PAGE_MAX_BYTES });
  if (!html) return { kind: "unavailable", reason: "The careers page could not be downloaded for this check. A more specific download failure was not recorded." };

  const classification = classifyFetchOutcome(html);
  if (classification.kind === "shell") {
    console.log(`crawler: ${company} careers page is a JS shell, using search tier`);
    return { kind: "shell" };
  }

  const sourceKey=`page:${careersUrl}`;
  const tenant=await resolveTenantId();
  const complete=classification.page.text.length<MAX_PAGE_CHARS && extractionLinks(classification.page).complete;
  const previous=complete?await readCrawlSnapshot(tenant,company,sourceKey,criteriaHash):null;
  const hash=pageFingerprint(classification.page,careersUrl);
  if(previous?.contentHash===hash) return {kind:"roles",roles:previous.listings.map(item=>item.role),
    snapshot:{...previous,capturedAt:new Date().toISOString()},cached:true,complete};

  const roles = await modelCall(async()=>rolesFromRaw(await callStructured({
    system: roleSearchSystem(profile.searchSubject),
    prompt: buildExtractionPrompt(
      company,
      classification.page,
      criteria,
      profile.candidatePersona,
      profile.buildingConcept,
      profile.buildingUpside
    ),
    maxTokens: 4000,
  })));
  return { kind: "roles", roles, cached:false,complete,
    snapshot:complete?{sourceKey,criteriaHash,contentHash:hash,listings:carryListingAttempts(roles.map(role=>({role,hash:contentFingerprint(role)})),previous?.listings??[]),
      processed:previous?.processed??{},capturedAt:new Date().toISOString()}:null };
}

async function extractViaSearch(
  company: string,
  careersUrl: string | null,
  criteria: Criteria,
  profile: Profile,
  maxSearches:number
): Promise<{ roles: Role[]; salvaged: boolean }> {
  const prompt = buildCompanyRolePrompt({
    company,
    careersUrl,
    criteria,
    searchSubject: profile.searchSubject,
    persona: profile.candidatePersona,
    buildingConcept: profile.buildingConcept,
    buildingUpside: profile.buildingUpside,
  });
  const { text: raw, stopReason } = await callWithWebSearchDetailed({
    system: roleSearchSystem(profile.searchSubject),
    prompt,
    // Search narration counts against the budget; 2000 has truncated the
    // response before the JSON was emitted.
    maxTokens: 16000,
    maxSearches,
    searchMode:"filtered",
  });

  // A prose response is recoverable; a TRUNCATED one is not, and parseOrSalvage
  // is where that distinction lives for all four search surfaces. Rethrowing on
  // truncation makes the run score "error" and
  // records the failed run without claiming the careers page is unreachable.
  const { items, salvaged } = await parseOrSalvage<Role>({
    raw,
    stopReason,
    key: "roles",
    itemNoun: "role",
    itemFields: ROLE_FIELDS,
    label: `crawler: ${company} search tier`,
    extract: rolesFrom,
  });
  return { roles: items, salvaged };
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
/**
 * Whether a finished run may be used to CLOSE postings.
 *
 * Two independent conditions, and the second is newer than the first.
 *
 * Status: only 'ok' and 'empty' ever carried listing evidence. 'error' and
 * 'needs_url' never do — a fetch failure is not evidence a role is gone.
 *
 * Provenance: a SALVAGED run is excluded regardless of status. Its roles came
 * from re-reading a prose answer, and prose meaning "I could not reach the
 * page" salvages to an empty array that is indistinguishable from "this company
 * lists nothing". Excluded even when it DID find roles: a transcription of
 * whatever the prose happened to mention is not a complete listing, so closing
 * every title absent from it would close roles the prose merely omitted.
 *
 * The cost, accepted: after a salvaged run, closure waits for the next normal
 * one. Closure is already a two-run rule, so it was never same-day.
 *
 * This must agree with LAST_TRUSTWORTHY_RUN_SQL below — this gates the CURRENT
 * run, that one picks the PREVIOUS run. Both are pinned by tests.
 */
export function runProvidesClosureEvidence(
  status: CrawlStatus,
  salvaged: boolean,
  board?: { source: "read" | "guessed" }
): boolean {
  if (salvaged) return false;
  if (board !== undefined) {
    // A board-sourced run may only close roles when the board is certainly the
    // employer's — a slug READ out of their own posting URL. A guessed slug
    // routed into this path would let a stranger's board close real roles, and
    // closure is the one operation here that writes `status`.
    if (board.source !== "read") return false;
    // And an EMPTY board is never evidence, however the slug was found: it is
    // indistinguishable from a parser that broke on a vendor shape change, and
    // the cost of being wrong is every crawl-sourced role at that company. The
    // HTML tier's `empty` means a page loaded and listed nothing, which is a
    // fact about the employer; a vendor's `{"jobs":[]}` is not.
    return status === "ok";
  }
  return status === "ok" || status === "empty";
}

export const LAST_TRUSTWORTHY_RUN_SQL = `select role_titles, finished_at from crawl_runs
      where tenant_id = $2 and company = $1 and status in ('ok', 'empty', 'unchanged')
        and not salvaged
        and closure_eligible and source_key=$3 and criteria_fingerprint=$4
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
async function lastSuccessfulTitles(company: string,sourceKey:string,criteriaHash:string): Promise<ClosureRun[]> {
  const { data } = await rawQuery<TrustworthyRunRow>(LAST_TRUSTWORTHY_RUN_SQL,
    [company, await resolveTenantId(),sourceKey,criteriaHash],
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
         and status = 'New'
         and not grading_chosen`;

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

  const configured = await getJobStatuses();
  const missingStatus = configured.error === undefined ? dispositionStatus("job_not_found", configured.statuses) : null;
  if (!missingStatus) {
    console.error("crawler: could not file missing roles; check terminal statuses in Settings", configured.error);
    return;
  }
  const closing = new Set(toClose);
  for (const job of active) {
    if (!closing.has(job.key)) continue;
    const { error: closeError } = await supabase.forTenant(await resolveTenantId())
      .from("jobs")
      .update({ status: missingStatus, disposition: "job_not_found", disposition_reason: null, updated_at: new Date().toISOString() })
      .eq("id", job.id)
      .eq("status", "New")
      .eq("source", "Crawl")
      .eq("grading_chosen", false);
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
  opts: { dryRun?: boolean; ctx?: RunContext; trigger?: CrawlTrigger } = {}
): Promise<CrawlOutcome> {
  const dryRun = opts.dryRun ?? false;
  const trigger=opts.trigger??"check";
  const tenantId=await resolveTenantId();
  const startingSearches=billingScope()?.searches??0;
  let reservedSearches=0;
  const searchRemaining=()=>Math.max(0,COMPANY_SEARCH_LIMIT-(billingScope() ? (billingScope()!.searches-startingSearches) : reservedSearches));
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
  let sourceRevision = tracked.source_revision ?? 0;
  if (!dryRun) {
    const { data: runRows, error: crawlRunInsertError } = await supabase.forTenant(await resolveTenantId())
      .from("crawl_runs")
      .insert({ company, status: "running", source_url: tracked.careers_url, source_revision: sourceRevision })
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
  // Set only when the board tier sourced this run's roles, and carried into the
  // closure decision: a guessed board may never close a role, and an empty
  // board is never evidence at all. See runProvidesClosureEvidence.
  let boardSource: "read" | "guessed" | null = null;
  let status: CrawlStatus = "error";
  let errorMessage: string | undefined;
  let roles: Role[] = [];
  let newRoles = 0;
  let seenTitles: string[] = [];
  // Provenance, not a workflow state: were these roles parsed, or recovered
  // from a prose response? Only the search tier can salvage today.
  let salvaged = false;

  let sourceKey:string|null=null;
  let criteriaHash:string|null=null;
  let closureEligible=false;
  let modelAttempt:"none"|"success"|"failure"="none";
  let careersUrl=tracked.careers_url;
  let snapshot:CrawlSnapshot|null=null;
  let snapshotPersisted=false;
  const listingModel=async <T,>(fn:()=>Promise<T>):Promise<T>=>{
    try { const value=await fn();modelAttempt="success";return value; }
    catch(error) {
      if(!(error instanceof SpendLimitReachedError) && !(error instanceof SearchUnavailableError) &&
        !(error as {billingPersistence?:boolean}|null)?.billingPersistence) modelAttempt="failure";
      throw error;
    }
  };
  try {
    await withAIAttribution({company,crawlRunId:runId??undefined,trigger:aiAttribution().trigger??(trigger==="automatic"?"scheduled":"manual"),phase:"company_check"},async()=>{
      const criteria=criteriaForCompany(ctx.criteria,tracked.ignore_location_rule);
      criteriaHash=criteriaFingerprint({criteria,fitInputs:ctx.fitInputs,profile:ctx.profile});
      const paid=paidSearchDecision({trigger,allowPaidSearch:tracked.allow_paid_search??false,modelRetryAfter:tracked.model_retry_after??null});
      const useSearch=async <T,>(max:number,fn:(cap:number)=>Promise<T>,sourceReason:string):Promise<T>=>{
        if(!paid.allowed) throw new SpendLimitReachedError(`${sourceReason} ${trigger === "check"
          ? "Check now does not use paid web search. Choose Deep search to allow up to 5 paid searches."
          : paid.reason ?? "Paid search is not enabled for this check. Use Deep search to permit it."}`);
        const cap=Math.min(max,searchRemaining());
        if(cap<=0) throw new SpendLimitReachedError("This company check reached its five-search limit.");
        reservedSearches+=cap;
        return listingModel(()=>fn(cap));
      };

      // Known employer boards are checked before any paid URL discovery.
      const board=await verifiedCompanyBoard({tenantId,company,careersUrl,storedUrls:await storedAtsLinks(company),dryRun});
      let directComplete=false;
      let listingComplete=false;
      if(board) {
        runMethod="fetch";
        boardSource=board.resolution.source;
        sourceKey=`board:${board.resolution.vendor}:${board.resolution.slug}:${careersUrl??""}`;
        const previous=await readCrawlSnapshot(tenantId,company,sourceKey,criteriaHash);
        roles=rolesFromBoard(board.postings,criteria.titles);
        const listings=roles.map(role=>{
          const posting=board.postings.find(item=>item.url===role.job_url);
          const body=posting?.body;
          // Vendors that omit description bodies need a bounded periodic read
          // even when title/URL remain unchanged. It is never proof of no change.
          const hash=criteriaFingerprint({content:contentFingerprint(role,body),material:posting?.material??null,
            bodyRefreshWindow:body?null:Math.floor(Date.now()/(7*86400000))});
          return {role,hash,...(body?{body}:{})};
        });
        snapshot={sourceKey,criteriaHash,contentHash:criteriaFingerprint(listings.map(item=>({key:listingKey(item.role),hash:item.hash})).sort((a,b)=>a.key.localeCompare(b.key))),
          listings:carryListingAttempts(listings,previous?.listings??[]),processed:previous?.processed??{},capturedAt:new Date().toISOString()};
        directComplete=board.resolution.source==="read" && board.postings.length>0;
        listingComplete=true;
      } else {
        if(!careersUrl) {
          careersUrl=await useSearch(2,cap=>resolveCareersUrl(company,cap),"No careers URL is saved, and no usable job board was found by the direct check.");
          if(careersUrl&&!dryRun) {
            const saved=await rawQuery<{source_revision: number}>(`update watchlist set careers_url=$3
              where tenant_id=$1 and company=$2 and source_revision=$4 returning source_revision`,[tenantId,company,careersUrl,sourceRevision],tenantId);
            const failure=describeWriteFailure(saved.error?.message,"remember the careers URL");
            if(failure!==undefined) throw new Error(failure);
            if (!saved.data.length) throw new Error("The careers page changed during this check. Run Check now for the current page.");
            sourceRevision=saved.data[0].source_revision;
          }
        }
        if(!careersUrl) {status="needs_url";errorMessage=`Could not find a careers page for "${company}". Add one on the Watchlist.`;return;}
        // Retry the inexpensive page even when an old run learned 'search'.
        // Sites change, and a permanent shell flag must not become permanent spend.
        const fetched=await extractViaFetch(company,careersUrl,criteria,ctx.profile,criteriaHash,listingModel);
        if(fetched.kind==="roles") {
          runMethod="fetch";learnedMethod="fetch";roles=fetched.roles;snapshot=fetched.snapshot;
          sourceKey=snapshot?.sourceKey??`page:${careersUrl}`;directComplete=fetched.complete;listingComplete=fetched.complete;
        } else {
          learnedMethod=fetched.kind==="shell"?"search":null;
          runMethod="search";
          const searched=await useSearch(COMPANY_SEARCH_LIMIT,cap=>extractViaSearch(company,careersUrl,criteria,ctx.profile,cap),
            fetched.kind === "shell" ? "The direct reader could not extract listings from this page. It may load jobs with JavaScript or use a layout the reader does not recognize." : fetched.reason);
          roles=searched.roles;salvaged=searched.salvaged;
          sourceKey=`search:${careersUrl}`;
          // A bounded search can find useful roles, never establish absence.
          directComplete=false;
        }
      }

      seenTitles=roles.map(role=>normalizeTitle(role.role_title));
      const candidates:ListingSnapshot[]=snapshot?candidatesToProcess(snapshot.listings,snapshot.processed):roles.map(role=>({role,hash:contentFingerprint(role)}));
      const previous=snapshot?(await readCrawlSnapshot(tenantId,company,snapshot.sourceKey,snapshot.criteriaHash)??
        await readCrawlSnapshot(tenantId,company,snapshot.sourceKey)??await readCrawlSnapshot(tenantId,company)):null;
      const oldKeys=new Set(previous?.listings.map(item=>listingKey(item.role))??[]);
      const oldTitles=new Set(previous?.listings.map(item=>normalizeTitle(item.role.role_title))??[]);
      const wasObserved=(item:ListingSnapshot)=>oldKeys.has(listingKey(item.role))||oldTitles.has(normalizeTitle(item.role.role_title));
      const work=snapshot?crawlProcessingQueue(snapshot.listings,snapshot.processed,MAX_INGEST_READS):candidates.slice(0,MAX_INGEST_READS);
      const lastAttempt=Math.max(0,...(snapshot?.listings??[]).map(item=>Date.parse(item.lastAttemptedAt??"")||0));
      const attemptedAt=new Date(Math.max(Date.now(),lastAttempt+1)).toISOString();
      const newItems:typeof work=[];
      for(const item of work) {
        item.lastAttemptedAt=attemptedAt;
        const key=listingKey(item.role);
        if(snapshot&&wasObserved(item)) {
          const done=await withAIAttribution({phase:"changed_listing"},()=>refreshChangedCrawlRole({company,role:item.role,body:item.body,fitInputs:ctx.fitInputs,dryRun}));
          if(done) snapshot.processed[key]=item.hash;
          // A previously observed listing may never have been inserted (a
          // budget or failed write). Ingest still owns safe insertion/dedupe.
          if(!done) newItems.push(item);
        } else newItems.push(item);
      }
      if(newItems.length) {
        const bodies:Record<string,string>={};
        for(const item of newItems) if(item.body) bodies[item.role.job_url]=item.body;
        const result=await withAIAttribution({phase:"new_listings"},()=>ingestRoles({company,roles:newItems.map(item=>item.role),
          companyContext:{tagline:tracked.tagline,traction:tracked.traction,careers_url:careersUrl,category:tracked.category,raised:tracked.raised,stage:tracked.stage},
          source:"Crawl",dryRun,fitInputs:ctx.fitInputs,postingBodies:bodies}));
        newRoles=result.added.length;
        if(snapshot&&!dryRun) {
          const settled=await settledCrawlRoles(tenantId,company,newItems.filter(item=>!wasObserved(item)).map(item=>item.role));
          for(const role of settled) {
            const item=newItems.find(candidate=>listingKey(candidate.role)===listingKey(role));
            if(item) snapshot.processed[listingKey(role)]=item.hash;
          }
          // For observed-but-never-stored roles only a NEW insert may settle
          // an old key; a failed refresh cannot borrow the previous grade.
          const inserted=await settledCrawlRoles(tenantId,company,result.added);
          for(const role of inserted) {
            const item=newItems.find(candidate=>listingKey(candidate.role)===listingKey(role));
            if(item) snapshot.processed[listingKey(role)]=item.hash;
          }
        }
      }
      const pending=snapshot?candidatesToProcess(snapshot.listings,snapshot.processed).length:Math.max(0,candidates.length-work.length);
      status=!listingComplete||pending>0?"partial":candidates.length===0&&roles.length>0?"unchanged":roles.length>0?"ok":"empty";
      if(status==="partial") {
        const remaining = pending > 0
          ? `${pending} matching role${pending === 1 ? " still needs" : "s still need"} processing.` : null;
        const unattempted = Math.max(0, candidates.length - work.length);
        const deferred = unattempted > 0
          ? `This check processes up to ${MAX_INGEST_READS} roles; ${unattempted} role${unattempted === 1 ? " was" : "s were"} left for another check.` : null;
        const attemptedPending = Math.max(0, pending - unattempted);
        const processing = attemptedPending > 0
          ? `${attemptedPending} attempted role${attemptedPending === 1 ? " did" : "s did"} not finish detail collection, grading, or saving. A more specific processing failure was not recorded in this company check.` : null;
        const coverage = !listingComplete ? (runMethod === "search"
          ? "Web search cannot confirm that every opening was checked."
          : "Only part of the careers page fit within this check's reading limit.") : null;
        errorMessage=[remaining,deferred,processing,coverage].filter(Boolean).join(" ");
      }
      closureEligible=directComplete&&runProvidesClosureEvidence(status==="unchanged"?"ok":status,salvaged,
        boardSource===null?undefined:{source:boardSource});
      if(snapshot&&!dryRun) {await saveCrawlSnapshot(tenantId,company,snapshot);snapshotPersisted=true;}
      if(closureEligible&&!dryRun&&sourceKey&&criteriaHash) {
        const previousRun=await lastSuccessfulTitles(company,sourceKey,criteriaHash);
        await closeStalePostings(company,[{finished_at:new Date().toISOString(),titles:seenTitles},...previousRun],ctx);
      }
    });
  } catch (err) {
    closureEligible=false;
    status=err instanceof SpendLimitReachedError||err instanceof SearchUnavailableError?(roles.length?"partial":"skipped"):"error";
    errorMessage=(err instanceof Error?err.message:"")||"The company check failed. Try again.";
    console.error(`crawler: ${company} failed — ${errorMessage}`);
  }
  // Extraction survives a processing failure, but only successful receipts
  // suppress another attempt. Dry runs cannot warm or mutate persistent state.
  if(snapshot&&!dryRun&&!snapshotPersisted) {
    try {await saveCrawlSnapshot(tenantId,company,snapshot);} catch(error) {
      status="error";closureEligible=false;errorMessage=error instanceof Error?error.message:"Could not save crawl source evidence.";
    }
  }
  // Assignments inside the attribution callback are real runtime outcomes;
  // TypeScript otherwise narrows this outer variable to only catch outcomes.
  status=status as CrawlStatus;
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
          salvaged,
          closure_eligible:closureEligible,
          source_key:sourceKey,
          criteria_fingerprint:criteriaHash,
          error: errorMessage ?? null,
          source_url: careersUrl,
          source_revision: sourceRevision,
        })
        .eq("id", runId);
      if (crawlRunUpdateError) {
        console.error(
          `crawler: ${company} failed to finalize crawl_runs row ${runId} — ${crawlRunUpdateError.message}`
        );
      }
    }

    // Neither a model error nor failure to discover a URL proves a page is
    // unreachable. Preserve health evidence on those outcomes; clear old
    // counters only after a successful listing. This pipeline has no typed,
    // verified page-unavailability result, so it cannot auto-disable tracking.
    const healthy = status === "ok" || status === "empty" || status === "unchanged";
    const { error: watchlistUpdateError } = await rawQuery(
      `update watchlist
          set last_checked_at = now(),
              crawl_method = coalesce($2, crawl_method),
              last_crawl_status = $3,
              last_crawl_error = $4,
              consecutive_failures = case when $5 then 0 else consecutive_failures end,
              failing_since = case when $5 then null else failing_since end
        where company = $1 and tenant_id = $6 and source_revision = $7`,
      [company, learnedMethod, status, errorMessage ?? null, healthy, await resolveTenantId(), sourceRevision],
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
    const policy=await crawlPolicyOutcome(tenantId,company,{trigger,modelAttempt,status,sourceRevision});
    if(policy.error!==undefined) {status="error";errorMessage=policy.error;}
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
