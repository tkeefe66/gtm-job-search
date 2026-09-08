"use server";

import { supabase } from "@/lib/supabase";
import { resolveTenantId } from "@/lib/tenant";
import { updateJob, getJobStatuses } from "@/app/actions/jobs";
import { checkJobUrl } from "@/lib/verify-url";
import { classifyJobLink } from "@/lib/job-link";
import { newBoardCache, resolveEmployerLink, verifyPostingLink } from "@/lib/resolve-job-link";
import type { BoardCache } from "@/lib/resolve-job-link";
import { relinkPatch } from "@/lib/relink";
import { describeWriteFailure } from "@/lib/write-failure";
import { bucketFor } from "@/lib/job-statuses";
import { deadPostingMarker } from "@/lib/dead-posting";
import { fetchAllowed, fetchPage } from "@/lib/fetch-page";
import type { UnclearReason } from "@/lib/link-report";
import type { Job } from "@/lib/types";

/**
 * Re-checks stored job links and repairs what it safely can.
 *
 * Exists because `checkJobUrl` runs ONCE at ingest and nothing ever looks
 * again. Postings close, and a role stays in the table reading "New" forever —
 * two rows were returning a hard 404 while displayed as open when this was
 * written.
 *
 * Costs no Claude tokens: HTTP HEADs and the vendors' public board endpoints
 * only. Safe to re-run.
 *
 * A role is closed on either of two definitive signals: its URL returns
 * 404/410, or the employer's own board lists NOTHING resembling the title.
 * The second is what actually catches reseller links, which answer 403 rather
 * than 404 when the posting behind them is gone.
 *
 * An AMBIGUOUS board match — several postings could be this role — is reported
 * and never acted on. Closing a live role over a wording difference is a worse
 * failure than leaving a dead one open, so the ambiguous case keeps a human in
 * the loop and the report hands the selection to the bulk status control. An
 * EMPTY board is reported the same way and under the same rule, but as its own
 * reason: it means the company hires somewhere this pass did not look, or the
 * guessed slug found a stranger's board.
 */

const BATCH = 5;

export interface LinkRepairRow {
  id: string;
  company: string;
  role_title: string;
  /**
   * Where the report should send the user for THIS row, which differs by
   * reason: the employer board we found for `ambiguous` and `empty`, and the
   * job-board link the row still carries for `unresolved`, where no employer
   * board was found at all.
   */
  url: string;
  /**
   * Which undecidable case this is. Carried per row rather than split into two
   * report fields so the banner can group them itself (`splitUnclear`) without
   * this action deciding how they are presented.
   */
  reason: UnclearReason;
}

export interface LinkRepairReport {
  checked: number;
  /** Aggregator links replaced with the employer's own posting. */
  relinked: number;
  /** Rows whose URL returned a definitive 404/410 and are now closed. */
  closed: number;
  /** Rows the employer's own board no longer lists, and are now closed. */
  closedUnlisted: number;
  /**
   * Rows whose own board — vendor and slug READ out of the stored link, not
   * guessed — no longer carries the posting id, and are now closed.
   *
   * Its own counter rather than folded into closedUnlisted: two boards found
   * two different ways are two different strengths of evidence, and one number
   * would hide which was which.
   */
  closedAbsent: number;
  /**
   * Rows whose PAGE says the posting is gone while its server answers 200 —
   * the aggregator soft-404. Its own counter for the same reason closedAbsent
   * is: the evidence is a different kind, and one number would hide which.
   */
  closedRemoved: number;
  /**
   * Every row this pass could not decide, with the reason on each. Three live
   * here (see UnclearReason): several postings could be this role, the board
   * lists nothing at all, or no employer board was found to check against.
   *
   * The third used to be a bare COUNT in this report — "4 still point at a job
   * board we can't see past" — so those rows could be counted but never seen,
   * and the user could not act on the one thing the summary told them about.
   * None of the three is ever auto-closed.
   */
  unclear: LinkRepairRow[];
  error?: string;
}

export async function repairJobLinks(): Promise<LinkRepairReport> {
  const empty: LinkRepairReport = {
    checked: 0,
    relinked: 0,
    closed: 0,
    closedUnlisted: 0,
    closedAbsent: 0,
    closedRemoved: 0,
    unclear: [],
  };

  const { data, error } = await supabase.forTenant(await resolveTenantId()).from("jobs").select("*");
  // Presence, not truthiness: an unreachable database rejects with an empty
  // message, and reading that as success would report "0 links checked, all
  // healthy" for a pipeline nobody could see.
  const readFailure = describeWriteFailure(error?.message, "read your roles to check their links");
  if (readFailure !== undefined) {
    console.error(`repairJobLinks: ${readFailure}`);
    return { ...empty, error: readFailure };
  }

  // This pass decides which roles cost a liveness check, so a failed config
  // read must not be silently bucketed on the defaults as though the terminal
  // set were known. Presence, not truthiness — same trap as the jobs read
  // above.
  const { statuses, error: statusesError } = await getJobStatuses();
  if (statusesError !== undefined) {
    const failure = describeWriteFailure(statusesError, "read your status settings to check links");
    console.error(`repairJobLinks: ${failure}`);
    return { ...empty, error: failure };
  }

  const jobs = ((data as Job[]) ?? []).filter(
    (j) => j.job_url && bucketFor(statuses, j.status) !== "terminal"
  );

  const report: LinkRepairReport = { ...empty };
  // Shared across the whole pass: several roles at one company hit one board,
  // and re-fetching it per role only risks a rate limit — which answers
  // `unreachable`, which is inert, which would silently disable the check.
  const boards = newBoardCache();
  // The frequency data this comment used to ask for was gathered on 2026-09-07
  // and the answer was yes: a read-slug `absent` now closes the role, and is
  // reported as closedAbsent.
  for (let i = 0; i < jobs.length; i += BATCH) {
    const results = await Promise.all(jobs.slice(i, i + BATCH).map((j) => repairOne(j, boards)));
    for (const r of results) {
      report.checked++;
      if (r.relinked) report.relinked++;
      if (r.closed) report.closed++;
      if (r.closedUnlisted) report.closedUnlisted++;
      if (r.closedAbsent) report.closedAbsent++;
      if (r.closedRemoved) report.closedRemoved++;
      // Not `if (r.unclear)` alone: the 404 check below repairOne's board
      // lookup can close a row that the lookup had already set aside as
      // undecidable. Listing it would offer the user a decision that has
      // already been made, on a row the table now shows as closed.
      if (r.unclear && !r.closed) report.unclear.push(r.unclear);
    }
  }

  console.log(
    `repairJobLinks: checked ${report.checked}, relinked ${report.relinked}, ` +
      `closed ${report.closed} (404) + ${report.closedUnlisted} (unlisted) + ` +
      `${report.closedAbsent} (gone from its own board) + ` +
      `${report.closedRemoved} (page says removed), ` +
      `unclear ${report.unclear.length} ` +
      `(${report.unclear.filter((r) => r.reason === "unresolved").length} of them unresolved), ` +
      `${report.closedAbsent} of those found by a slug read from the link`
  );
  return report;
}

interface RepairOutcome {
  relinked?: boolean;
  closed?: boolean;
  closedUnlisted?: boolean;
  unclear?: LinkRepairRow;
  /**
   * The employer's OWN board — vendor and slug read out of the stored link, not
   * guessed — does not carry this posting id and lists nothing resembling the
   * title. The role is CLOSED on this now; see the branch below.
   */
  closedAbsent?: boolean;
  /** The page itself said the posting is gone, whatever its status code was. */
  closedRemoved?: boolean;
}

async function repairOne(job: Job, boards: BoardCache): Promise<RepairOutcome> {
  const url = job.job_url as string;
  const out: RepairOutcome = {};
  let liveUrl = url;

  const kind = classifyJobLink(url);

  // An ATS deep link names its own vendor and slug, so they are READ out of the
  // URL rather than guessed from the company name, and the board can be asked
  // about this exact posting id. This branch is why the pass now catches a dead
  // Ashby link: Ashby's posting page is a client-rendered SPA that answers 200
  // and then paints "Job not found", so the checkJobUrl below sees it as
  // healthy, and before this the whole board block sat behind
  // `=== "aggregator"` — correct that the HOST is the employer, wrong that the
  // posting id is therefore valid.
  if (kind === "ats") {
    const verified = await verifyPostingLink(url, job.role_title, boards);
    if (verified.kind === "relink") {
      const failure = describeWriteFailure(
        // source_url keeps the link being overwritten, exactly as the
        // aggregator branch does, and for the same non-lossy reason — even
        // though the slug here was read rather than guessed.
        (await updateJob(job.id, relinkPatch(job, url, verified.url)))
          .error,
        `relink ${job.company} / ${job.role_title}`
      );
      if (failure === undefined) {
        out.relinked = true;
        liveUrl = verified.url;
      } else {
        console.error(`repairJobLinks: ${failure}`);
      }
    } else if (verified.kind === "unclear") {
      out.unclear = {
        id: job.id,
        company: job.company,
        role_title: job.role_title,
        url: verified.url,
        reason: verified.reason,
      };
    } else if (verified.kind === "absent") {
      // Closed on evidence, since 2026-09-07. The board being asked is
      // certainly the employer's — vendor and slug were READ out of the stored
      // URL, not guessed from the company name — and it answers that this
      // posting id is gone and that nothing on it resembles the title.
      //
      // Nothing else catches these. Greenhouse 302s a removed posting to its
      // board root, so checkJobUrl follows the redirect, sees 200, and calls
      // the link live; four sampled rows were all in that state and ~18 sat as
      // New indefinitely. The counter-argument this branch used to carry — that
      // closing "marks a role never-live and hides it" — was simply false: the
      // write below is a status and nothing else, never_live is ingest-time
      // provenance, and partitionNeverLive hides on never_live rather than on
      // status. A role closed here stays visible under Out and can be moved
      // back by hand.
      const failure = describeWriteFailure(
        (await updateJob(job.id, { status: "Posting Closed" })).error,
        `close ${job.company} / ${job.role_title}`
      );
      if (failure === undefined) out.closedAbsent = true;
      else console.error(`repairJobLinks: ${failure}`);
    }
    // `listed` (the link is fine), `unreachable` (a board we could not read
    // says nothing), `notApplicable` (a bare board page, or an ATS with no
    // honest board API) and `absent` all do nothing. `absent` is deliberate:
    // it is strong evidence the posting is gone, but closing a role also marks
    // it never-live, and this change does not widen what closes roles.
  } else if (kind === "aggregator") {
    const resolved = await resolveEmployerLink(job.company, job.role_title);
    if (resolved?.precision === "posting") {
      const failure = describeWriteFailure(
        // source_url keeps the link we are about to overwrite, so a relink is
        // never lossy — the slug is a GUESS, and a wrong one would otherwise
        // destroy the only URL this role ever had. Written only on the first
        // relink; a re-run must not overwrite the original with the previous
        // resolution.
        (await updateJob(job.id, relinkPatch(job, url, resolved.url)))
          .error,
        `relink ${job.company} / ${job.role_title}`
      );
      if (failure === undefined) {
        out.relinked = true;
        liveUrl = resolved.url;
      } else {
        console.error(`repairJobLinks: ${failure}`);
      }
    } else if (resolved?.precision === "absent") {
      // The employer's own board lists nothing resembling this title. Same
      // rule the ingest path uses, so a role cannot pass at the door and then
      // be judged differently a day later.
      const failure = describeWriteFailure(
        (await updateJob(job.id, { status: "Posting Closed" })).error,
        `close ${job.company} / ${job.role_title}`
      );
      if (failure === undefined) out.closedUnlisted = true;
      else console.error(`repairJobLinks: ${failure}`);
    } else if (resolved) {
      // `ambiguous` (near-matches we cannot tell apart) or `empty` (a board
      // under this company's slug that lists nothing at all). Neither closes a
      // role; both are reported for the user. The reason travels with the row
      // because the two need different sentences — an empty board is checked
      // against the company's real careers page, since the slug was a GUESS and
      // the board may not be theirs.
      out.unclear = {
        id: job.id,
        company: job.company,
        role_title: job.role_title,
        url: resolved.url,
        reason: resolved.precision === "empty" ? "empty" : "ambiguous",
      };
    } else {
      // No employer board found under any slug or vendor. The row keeps its
      // job-board link, and that link is what the report points at — there is
      // nothing better to send the user to. NOT closable: an unfindable board
      // says nothing about whether the posting is live.
      out.unclear = {
        id: job.id,
        company: job.company,
        role_title: job.role_title,
        url,
        reason: "unresolved",
      };
    }
  }

  // Only a definitive 404/410 closes a role here — checkJobUrl's existing rule,
  // kept because job boards answer 403 to anything that looks like a bot and an
  // ambiguous signal must never close a live posting. Skipped for a row a board
  // has already closed above, which would otherwise write the same status
  // twice and count one closure under two reasons.
  if (!out.closedAbsent && !out.closedUnlisted && (await checkJobUrl(liveUrl)) === "dead") {
    const failure = describeWriteFailure(
      (await updateJob(job.id, { status: "Posting Closed" })).error,
      `close ${job.company} / ${job.role_title}`
    );
    if (failure === undefined) out.closed = true;
    else console.error(`repairJobLinks: ${failure}`);
  }

  // The SOFT 404, and the only thing that catches it. An aggregator answers 200
  // with a page that says the job is gone — a real BuiltIn row read "Sorry,
  // this job was removed at 04:07 a.m. (UTC)" while every status-code check
  // called it live. Costs one GET and no Claude tokens, and only runs for a row
  // nothing above has already closed.
  //
  // Not everything is reachable this way: ZipRecruiter answers 403 to this
  // fetch, so its dead rows stay open and no free signal exists for them.
  if (!out.closed && !out.closedAbsent && !out.closedUnlisted) {
    const removed = await removalMarker(liveUrl);
    if (removed !== null) {
      const failure = describeWriteFailure(
        (await updateJob(job.id, { status: "Posting Closed" })).error,
        `close ${job.company} / ${job.role_title}`
      );
      if (failure === undefined) {
        out.closedRemoved = true;
        console.log(
          `repairJobLinks: ${job.company} / ${job.role_title} — page says "${removed}", closed`
        );
      } else {
        console.error(`repairJobLinks: ${failure}`);
      }
    }
  }

  return out;
}

/**
 * The phrase a posting's page uses to say it is gone, or null.
 *
 * Gated on robots BEFORE the fetch, the same rule the crawler follows and the
 * reason fetchAllowed and fetchPage live in one module: a robots.txt that could
 * not be read is not permission.
 */
async function removalMarker(url: string): Promise<string | null> {
  if (!(await fetchAllowed(url))) return null;
  const html = await fetchPage(url);
  return html === null ? null : deadPostingMarker(html);
}
