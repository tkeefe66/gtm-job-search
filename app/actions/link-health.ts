"use server";

import { supabase } from "@/lib/supabase";
import { resolveTenantId } from "@/lib/tenant";
import { updateJob, getJobStatuses } from "@/app/actions/jobs";
import { checkJobUrl } from "@/lib/verify-url";
import { classifyJobLink } from "@/lib/job-link";
import { resolveEmployerLink } from "@/lib/resolve-job-link";
import { describeWriteFailure } from "@/lib/write-failure";
import { bucketFor } from "@/lib/job-statuses";
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
  boardUrl: string;
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
   * Board found but the outcome was undecidable — reported, never auto-closed.
   * Two reasons live here (see UnclearReason): several postings could be this
   * role, or the board lists nothing at all.
   */
  unclear: LinkRepairRow[];
  /** Aggregator links we could not improve at all. */
  unresolved: number;
  error?: string;
}

export async function repairJobLinks(): Promise<LinkRepairReport> {
  const empty: LinkRepairReport = {
    checked: 0,
    relinked: 0,
    closed: 0,
    closedUnlisted: 0,
    unclear: [],
    unresolved: 0,
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
  for (let i = 0; i < jobs.length; i += BATCH) {
    const results = await Promise.all(jobs.slice(i, i + BATCH).map(repairOne));
    for (const r of results) {
      report.checked++;
      if (r.relinked) report.relinked++;
      if (r.closed) report.closed++;
      if (r.closedUnlisted) report.closedUnlisted++;
      if (r.unresolved) report.unresolved++;
      if (r.unclear) report.unclear.push(r.unclear);
    }
  }

  console.log(
    `repairJobLinks: checked ${report.checked}, relinked ${report.relinked}, ` +
      `closed ${report.closed} (404) + ${report.closedUnlisted} (unlisted), ` +
      `unclear ${report.unclear.length}, unresolved ${report.unresolved}`
  );
  return report;
}

interface RepairOutcome {
  relinked?: boolean;
  closed?: boolean;
  closedUnlisted?: boolean;
  unresolved?: boolean;
  unclear?: LinkRepairRow;
}

async function repairOne(job: Job): Promise<RepairOutcome> {
  const url = job.job_url as string;
  const out: RepairOutcome = {};
  let liveUrl = url;

  if (classifyJobLink(url) === "aggregator") {
    const resolved = await resolveEmployerLink(job.company, job.role_title);
    if (resolved?.precision === "posting") {
      const failure = describeWriteFailure(
        // source_url keeps the link we are about to overwrite, so a relink is
        // never lossy — the slug is a GUESS, and a wrong one would otherwise
        // destroy the only URL this role ever had. Written only on the first
        // relink; a re-run must not overwrite the original with the previous
        // resolution.
        (await updateJob(job.id, { job_url: resolved.url, source_url: job.source_url ?? url }))
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
        boardUrl: resolved.url,
        reason: resolved.precision === "empty" ? "empty" : "ambiguous",
      };
    } else {
      out.unresolved = true;
    }
  }

  // Only a definitive 404/410 closes a role — checkJobUrl's existing rule, kept
  // because job boards answer 403 to anything that looks like a bot and an
  // ambiguous signal must never close a live posting.
  if ((await checkJobUrl(liveUrl)) === "dead") {
    const failure = describeWriteFailure(
      (await updateJob(job.id, { status: "Posting Closed" })).error,
      `close ${job.company} / ${job.role_title}`
    );
    if (failure === undefined) out.closed = true;
    else console.error(`repairJobLinks: ${failure}`);
  }

  return out;
}
