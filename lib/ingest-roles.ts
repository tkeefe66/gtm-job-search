import { rawQuery } from "@/lib/supabase";
import { resolveTenantId } from "@/lib/tenant";
import { addJob, getJobStatuses } from "@/app/actions/jobs";
import { scoreFit } from "@/app/actions/parse-role";
import { randomUUID } from "node:crypto";
import { gradingPaused, recordGradeFailure, updateMissingGrade } from "./grading-store";
import type { FitInputs } from "@/lib/fit-inputs";
import { checkJobUrl } from "@/lib/verify-url";
import { classifyJobLink } from "@/lib/job-link";
import { newBoardCache, resolveEmployerLink, verifyPostingLink } from "@/lib/resolve-job-link";
import type { BoardCache } from "@/lib/resolve-job-link";
import { postingDetailFrom } from "@/lib/posting-detail";
import { betterCompanyName } from "@/lib/company-name";
import { notAPosting } from "@/lib/not-a-posting";
import { autoFileStatus, shouldAutoFile } from "@/lib/fit-cutoff";
import { readDetail, readPosting, type PostingRead } from "@/lib/posting-read";
import { describeWriteFailure } from "@/lib/write-failure";
import {
  NORMALIZED_COMPANY_SQL,
  normalizeCompanyName,
  normalizeRoleKey,
  normalizeTitle,
} from "@/lib/role-key";
import type { Role } from "@/lib/types";

export interface IngestCompanyContext {
  tagline?: string | null;
  traction?: string | null;
  careers_url?: string | null;
  category?: string | null;
  raised?: string | null;
  stage?: string | null;
}

export interface IngestOptions {
  company: string;
  roles: Role[];
  companyContext?: IngestCompanyContext;
  source: string; // 'Discover' | 'Crawl' | 'Role Search'
  dryRun?: boolean;
  // Carried as FitInputs rather than the whole Criteria object on purpose:
  // ingestRoles uses nothing else from criteria, and the narrower type is what
  // kept the compensation floor from re-widening this interface — it arrived
  // as a field ON FitInputs, so no option and no call site here changed.
  // Required (not optional with a load-on-demand fallback) because every
  // caller here is a batch path — a per-row settings read inside the
  // Promise.all below would be one database round trip per scored role.
  fitInputs: FitInputs;
  /**
   * Postings this caller has ALREADY read, keyed by the URL they were read
   * from. Manual URL intake reads before it knows what the role is — that is
   * how it learns the company and title — so re-reading here would spend a
   * second fetch and a second model call to learn what the caller already
   * holds.
   */
  preRead?: Record<string, PostingRead>;
  /**
   * How many postings this ingest may read, when it has to read them itself.
   * Defaults to MAX_INGEST_READS, which exists to fit the crawler's single
   * request inside Railway's 300s edge timeout. A user-initiated action is
   * waiting on its own response and can afford more.
   */
  maxReads?: number;
  /**
   * These roles were CHOSEN by the user, not found by a search.
   *
   * The fit cutoff is switched off for them, and only for them. It exists to
   * stop a search's own output filling the table; a URL someone pasted is a
   * decision the app must not silently overturn — the first manually added role
   * scored 2, filed itself, and disappeared from the open list, which is the
   * opposite of what adding something means. They are still SCORED, so the
   * number is honest and the user can act on it.
   */
  chosenByUser?: boolean;
}

/**
 * How many of one ingest's new roles get their posting READ.
 *
 * Not a ration on quality — a bound on one REQUEST. Railway closes a request
 * that transfers no data after 300s, the crawler gets exactly one request per
 * company, and a measured crawl already costs up to 91s before any of this. A
 * company posting thirty new roles must not turn one crawl into thirty fetches
 * and thirty model calls; the rest are stored unread, stay in the backfill's
 * queue (`thinJobs` keys on the enrichedAt stamp, not on the column), and the
 * Enrich button on /roles covers them at the user's pace.
 */
export const MAX_INGEST_READS = 6;

/**
 * The read budget for a USER-INITIATED search, which is a different kind of
 * request from a cron crawl: nobody is holding a 300s edge timeout open for a
 * batch of companies, one person is waiting on their own click and would rather
 * wait longer for rows they can act on.
 *
 * Measured 2026-09-07, this is the bound that matters most: Role Search made
 * 133 of 195 rows and owns 46 of the 59 unread-and-open ones, so the cron-safe
 * six was rationing exactly the path that produces four fifths of the table.
 * Twenty covers a normal run whole; beyond that the Enrich button on /roles
 * picks up the remainder at the user's pace.
 */
export const MAX_SEARCH_READS = 20;

export interface IngestResult {
  added: Role[];
  skipped: Role[];
  seenTitles: string[];
}

/**
 * Dedupes roles against the jobs table, verifies their URLs, inserts the new
 * ones, and fit-scores the live ones.
 *
 * Dedupe deliberately ignores job status. A role the user already marked
 * Rejected or Not Interested must never come back as New on a later crawl.
 */
export async function ingestRoles(opts: IngestOptions): Promise<IngestResult> {
  const { company, roles, source, fitInputs, dryRun = false } = opts;
  const ctx = opts.companyContext ?? {};
  const seenTitles = roles.map((r) => normalizeTitle(r.role_title));

  // Normalized on both sides on purpose: normalizeRoleKey collapses casing
  // AND whitespace for the dedupe comparison below, but a lookup that only
  // matched on `lower(company) = lower($1)` would make that half-decorative —
  // SQL lower() does not collapse internal whitespace, so a row stored as
  // "Big  Co" (double space, or a scraped U+00A0) would be invisible to a
  // crawl passing "Big Co" and every role would look new and re-insert as a
  // duplicate "New" job.
  //
  // This WHERE decides which rows get LOADED, so it has to narrow in SQL —
  // the TypeScript-side match app/actions/watchlist.ts uses would mean
  // reading the whole (unbounded) jobs table. NORMALIZED_COMPANY_SQL is
  // therefore the SQL twin of normalizeCompanyName; both live in
  // lib/role-key.ts with the comment explaining why they must stay in sync,
  // and the parameter below is normalized by the TS one so the two sides are
  // always compared under definitions that agree.
  //
  // rawQuery is the escape hatch since the builder's filter surface
  // (.eq/.neq) can't express a normalizing expression. Its error is rethrown
  // below, deliberately unswallowed: a malformed expression must fail loudly
  // on the first crawl rather than quietly degrade to "everything is new".
  const { data: existing, error } = await rawQuery<{
    role_title: string;
    job_url: string | null;
  }>(
    `select role_title, job_url from jobs
      where tenant_id = $2 and ${NORMALIZED_COMPANY_SQL} = $1`,
    [normalizeCompanyName(company), await resolveTenantId()],
    await resolveTenantId()
  );

  if (error) {
    throw new Error(`ingestRoles: could not read existing jobs — ${error.message}`);
  }

  const knownKeys = new Set<string>();
  const knownUrls = new Set<string>();
  for (const row of (existing ?? []) as { role_title: string; job_url: string | null }[]) {
    knownKeys.add(normalizeRoleKey(company, row.role_title));
    if (row.job_url) knownUrls.add(row.job_url);
  }

  const added: Role[] = [];
  const skipped: Role[] = [];
  const fresh: Role[] = [];

  for (const role of roles) {
    // Rejected before anything is spent on them: a job board's SEARCH page is
    // not a posting and a description is not an employer, so there is nothing
    // to read, verify or apply to. Found in production as 15 stored rows that
    // had been scored and were sitting in the open pipeline. See
    // lib/not-a-posting.ts for why both checks are narrow.
    const bogus = notAPosting(role.job_url, company);
    if (bogus !== null) {
      console.log(
        `ingestRoles(${company}): skipping "${role.role_title}" — ${bogus} (${role.job_url || "no link"})`
      );
      continue;
    }
    const isKnown =
      knownKeys.has(normalizeRoleKey(company, role.role_title)) ||
      (!!role.job_url && knownUrls.has(role.job_url));
    if (isKnown) skipped.push(role);
    else fresh.push(role);
  }

  // Second-hand links are upgraded BEFORE they are checked, because the check
  // cannot see past them: a reseller answers 403 to anything that looks like a
  // bot, so an expired copy of a posting passes as live and the role lands as
  // "New". Asking the employer's own board instead answers both questions at
  // once — where the real posting is, and whether it still exists.
  // One cache for this ingest: twenty fresh roles at one company share a single
  // board fetch instead of stampeding the same endpoint twenty times over.
  const boards = newBoardCache();
  const links = await Promise.all(fresh.map((r) => upgradeLink(company, r, boards)));
  const urlStatuses = await Promise.all(links.map((l) => checkJobUrl(l.url)));
  const unlisted = links.filter((l) => l.unlisted).length;
  console.log(
    `ingestRoles(${company}): ${roles.length} found, ${fresh.length} new, ` +
      `${urlStatuses.filter((s) => s === "dead").length} dead URLs, ` +
      `${links.filter((l) => l.sourceUrl).length} relinked to the employer, ` +
      `${unlisted} not on the employer's board, source=${source}`
  );

  if (dryRun) {
    return { added: fresh, skipped, seenTitles };
  }

  // Joined only over the parts that exist. `${tagline}. ${traction}` yielded
  // the literal "." when both were absent — the common case on Discover and
  // Crawl, whose context fields are frequently null — and buildFitPrompt
  // renders company_description raw, with no "unknown" fallback, so "." went
  // to the model as the company's description.
  // The tenant's OWN statuses, read once per ingest rather than per role: the
  // cutoff below files a weak role into whatever terminal status they actually
  // have, and a hardcoded key would not survive an edit on /settings. A failed
  // read leaves `fileInto` null, which files nothing — the roles stay New and
  // cost one rescore each, which is the harmless direction.
  const { statuses, error: statusesError } = await getJobStatuses();
  const fileInto = statusesError === undefined ? autoFileStatus(statuses) : null;

  const companyDescription = [ctx.tagline, ctx.traction]
    .map((part) => (part ?? "").trim())
    .filter((part) => part !== "")
    .join(". ");

  // Read BEFORE the insert, and therefore before the score.
  //
  // This is the whole ordering argument: fit_score is computed below, so a role
  // scored from the extraction's one-line summary — one search prompt covering
  // ten roles — carries a number computed without the posting's own words, and
  // fixing it later costs three operations (score, read, rescore) where one
  // ordering gets it right once.
  //
  // Bounded and only for roles worth reading: a role whose URL already 404s has
  // nothing to apply for, and one with no URL has nothing to fetch. Serial
  // within the bound, because these roles are all at ONE company and usually on
  // one host — the same politeness the robots gate exists for.
  const reads = new Map<number, PostingRead>();
  if (!dryRun) {
    let budget = opts.maxReads ?? MAX_INGEST_READS;
    // The loop runs over EVERY fresh role, not only while budget remains: a
    // posting the caller already read costs nothing, and gating it behind the
    // budget dropped every pre-read past the sixth — silently, for the one
    // caller that hands over reads in bulk.
    for (let i = 0; i < fresh.length; i++) {
      const deadUrl = urlStatuses[i] === "dead";
      if (deadUrl || links[i].unlisted || !links[i].url) continue;
      const already = opts.preRead?.[links[i].url];
      if (already) {
        reads.set(i, already);
        continue;
      }
      if (budget <= 0) continue;
      budget--;
      reads.set(
        i,
        await readPosting({
          url: links[i].url,
          company,
          roleTitle: fresh[i].role_title,
          label: `ingestRoles(${source})`,
        })
      );
    }
  }

  await Promise.all(
    fresh.map(async (role, i) => {
      // Two independent ways to already be closed: the link 404s, or the
      // employer's own board does not list the role. The second is what
      // actually catches reseller links, which rarely 404.
      //
      // checkJobUrl runs on links[i].url, which after upgradeLink may be a
      // "posting"-precision URL built from a GUESSED board slug rather than
      // the URL the search actually returned. That does not weaken this
      // signal: a "posting" URL is read off the board API's own listing, so a
      // wrong guess would land on a live stranger's posting (a 200) rather
      // than a 404 — a guess can produce a false "live", never a false "dead".
      const deadUrl = urlStatuses[i] === "dead";
      // The column's only producer. Written once and read back by every
      // rescore (lib/rescore-scope.ts), so the same value has to be what
      // scoreFit is given below.
      // The posting's own words win over the extraction's, because they ARE
      // the posting; the extraction is one search prompt covering ten roles.
      const read = reads.get(i);
      const wasRead = read?.kind === "read" ? read : null;
      const department = (wasRead?.department || role.department || "").trim();
      const summary = wasRead?.summary || role.description_summary || "";
      const isDead = deadUrl || links[i].unlisted;
      const gradingLease = randomUUID();

      // The employer's own spelling, when the read found one and it is the same
      // name written better. Per-ROW rather than per-ingest: the correction
      // comes from the posting this row points at, and only that row's link is
      // evidence about it. betterCompanyName is deliberately narrow — a legal
      // entity or a differently-worded brand is not an improvement.
      const storedCompany = (wasRead && betterCompanyName(company, wasRead.employer)) || company;

      const jobRes = await addJob({
        company: storedCompany,
        role_title: role.role_title,
        status: isDead ? "Posting Closed" : "New",
        // NARROWER than isDead, deliberately. `unlisted` means a board found by
        // GUESSING a slug from the company name did not list this title —
        // link-health already refuses to CLOSE a role on that signal, and
        // hiding on it is worse: the dedupe above reads every row regardless of
        // status, so a hidden row can never be re-found. A wrong guess would
        // disappear a live role permanently, with nothing on screen.
        never_live: deadUrl,
        seniority: role.seniority || null,
        location: role.location || null,
        job_url: links[i].url || null,
        source_url: links[i].sourceUrl,
        careers_url: ctx.careers_url || null,
        category: ctx.category || null,
        raised: ctx.raised || null,
        stage: ctx.stage || null,
        traction: ctx.traction || null,
        salary_range: role.salary_range || null,
        fit_summary: role.fit_signal || null,
        // Stored, not merely scored on. These two are exactly what scoreFit is
        // given below, and a rescore reads them back off the row
        // (lib/rescore-scope.ts). Omitting them made every rescore run on ""
        // where the first score saw the posting's own words.
        key_skills: summary || null,
        company_description: companyDescription,
        department: department || null,
        // Stamped only when the posting itself was read. Unstamped, the row
        // stays in the backfill's queue (see thinJobs) — which is correct: what
        // it carries then is the extraction's guess, not the posting.
        posting: wasRead ? readDetail(wasRead) : postingDetailFrom(role),
        ic_flag: role.ic_flag ?? false,
        source,
        grading_chosen: opts.chosenByUser === true,
        grading_state: isDead ? "skipped" : "running",
        grading_attempts: isDead ? 0 : 1,
        grading_lease: isDead ? null : gradingLease,
        grading_next_at: isDead ? null : new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      });

      // describeWriteFailure, not `if (jobRes.error)`. Presence, not
      // truthiness: an unreachable database rejects with an empty message
      // (see lib/write-failure.ts), which a truthiness check reads as a
      // successful insert — the role would then be pushed to `added` and
      // reported as stored, and the next crawl's dedupe would skip it.
      const failure = describeWriteFailure(
        jobRes.error,
        `store ${company} / ${role.role_title}`
      );
      if (failure !== undefined) {
        console.error(`ingestRoles: ${failure}`);
        return;
      }

      added.push(role);

      if (jobRes.job && !isDead) {
        const paused = await gradingPaused();
        if (paused) {
          await recordGradeFailure(jobRes.job.id, gradingLease, 1, {kind:"blocked", message:paused});
          return;
        }
        const scored = await scoreFit({
          company: storedCompany,
          role_title: role.role_title,
          company_description: companyDescription,
          key_skills: summary,
          fit_summary: role.fit_signal,
          department,
          location: role.location,
          // The posting's own words, unparsed. Scoring reads compensation as
          // context, not as a filter — the extraction prompt never sees it,
          // and nothing here drops a role for being below the floor.
          salary_range: role.salary_range || "",
          fitInputs,
        });
        if (scored.score > 0) {
          // Filed away rather than left New when the posting was READ and still
          // scored below the bar — see lib/fit-cutoff.ts for why the read is a
          // precondition. Written in the SAME update as the score, so a row can
          // never exist scored-but-unfiled.
          const file =
            opts.chosenByUser !== true &&
            fileInto !== null &&
            shouldAutoFile({ score: scored.score, wasRead: wasRead !== null, status: "New" });
          const saved = await updateMissingGrade(jobRes.job.id, {
            fit_score: scored.score,
            fit_summary: scored.rationale || role.fit_signal || null,
            ...(file ? { status: fileInto } : {}),
          }, gradingLease, statuses.filter(s => s.bucket === "terminal" || s.hidden).map(s => s.key));
          if (saved.error !== undefined) console.error(`ingestRoles: ${saved.error}`);
          if (file) {
            console.log(
              `ingestRoles(${company}): ${role.role_title} scored ${scored.score}, filed as ${fileInto}`
            );
          }
        } else {
          await recordGradeFailure(jobRes.job.id, gradingLease, 1, {
            kind: scored.failureKind ?? "transient",
            message: scored.error || "Grading failed temporarily. It will retry automatically.",
          });
        }
      }
    })
  );

  return { added, skipped, seenTitles };
}

interface UpgradedLink {
  /** What the role should link to. */
  url: string;
  /** The reseller link we replaced, or null when nothing was replaced. */
  sourceUrl: string | null;
  /** The employer's board exists and does not list this role. */
  unlisted: boolean;
}

/**
 * Swaps a reseller link for the employer's own posting where one can be found,
 * and repoints an employer's own DEEP link whose posting id has gone stale.
 *
 * Two different lookups, because they answer two different questions:
 *
 *  - An AGGREGATOR link says nothing about which board the role lives on, so
 *    the slug has to be GUESSED from the company name. Everything downstream of
 *    that guess hedges accordingly.
 *  - An ATS deep link already names its vendor and slug, so they are READ
 *    rather than guessed (`parseBoardLink`) and the board can be asked about
 *    this exact posting id. That is what catches Ashby: its posting page is a
 *    client-rendered SPA that answers HTTP 200 and then paints "Job not found",
 *    so `checkJobUrl` sees a healthy link and the old `!== "aggregator"` early
 *    return meant the employer's own honest board API was never consulted.
 *
 * A company domain or an ATS with no honest board API still returns early:
 * there is nothing to ask.
 *
 * `unlisted` is set only on the aggregator path's `absent` (nothing on the
 * guessed board resembles the title), never on `ambiguous`: closing a live role
 * because two postings had similar names would be a worse bug than the one this
 * fixes. It is deliberately NOT set on the new ATS path either — a missing
 * posting id on a correctly-parsed board IS strong evidence, but `unlisted`
 * closes a role and marks it never-live, and widening what closes roles is not
 * what this change is for. Costs no Claude tokens.
 */
async function upgradeLink(
  company: string,
  role: Role,
  boards: BoardCache
): Promise<UpgradedLink> {
  const url = role.job_url || "";
  const plain: UpgradedLink = { url, sourceUrl: null, unlisted: false };
  const kind = classifyJobLink(url);

  if (kind === "ats") {
    const verified = await verifyPostingLink(url, role.role_title, boards);
    // Only `relink` acts. `listed` is a healthy link; `unreachable`,
    // `notApplicable`, `unclear` and `absent` are all inert here — see
    // PostingVerification for why each one is.
    return verified.kind === "relink"
      ? { url: verified.url, sourceUrl: url, unlisted: false }
      : plain;
  }

  if (kind !== "aggregator") return plain;

  const resolved = await resolveEmployerLink(company, role.role_title);
  if (!resolved) return plain;
  if (resolved.precision === "posting") {
    return { url: resolved.url, sourceUrl: url, unlisted: false };
  }
  // Board-level outcomes keep the original link: the board page is a fine
  // destination but it is not this role, and overwriting the only record of
  // where the role was found to point at a directory helps nobody.
  return { url, sourceUrl: null, unlisted: resolved.precision === "absent" };
}
