"use server";

import { supabase } from "@/lib/supabase";
import { updateJob } from "@/app/actions/jobs";
import { checkJobUrl } from "@/lib/verify-url";
import { classifyJobLink } from "@/lib/job-link";
import { resolveEmployerLink } from "@/lib/resolve-job-link";
import { describeWriteFailure } from "@/lib/write-failure";
import { TERMINAL_STATUSES, type Job } from "@/lib/types";

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
 * What it deliberately does NOT do: close a role because the employer's board
 * no longer lists it. That is strong evidence of closure — and it is how most
 * of the aggregator rows in this pipeline actually died — but the board is
 * found by GUESSING a slug from the company name, so a name collision would
 * close a live role against a stranger's board. Those rows are REPORTED for
 * the user to triage with the bulk status control instead.
 */

const BATCH = 5;

export interface LinkRepairRow {
  id: string;
  company: string;
  role_title: string;
  boardUrl: string;
}

export interface LinkRepairReport {
  checked: number;
  /** Aggregator links replaced with the employer's own posting. */
  relinked: number;
  /** Rows whose URL returned a definitive 404/410 and are now closed. */
  closed: number;
  /** Employer board found, role absent — probably closed, needs a human. */
  probablyClosed: LinkRepairRow[];
  /** Aggregator links we could not improve at all. */
  unresolved: number;
  error?: string;
}

export async function repairJobLinks(): Promise<LinkRepairReport> {
  const empty: LinkRepairReport = {
    checked: 0,
    relinked: 0,
    closed: 0,
    probablyClosed: [],
    unresolved: 0,
  };

  const { data, error } = await supabase.from("jobs").select("*");
  // Presence, not truthiness: an unreachable database rejects with an empty
  // message, and reading that as success would report "0 links checked, all
  // healthy" for a pipeline nobody could see.
  const readFailure = describeWriteFailure(error?.message, "read your roles to check their links");
  if (readFailure !== undefined) {
    console.error(`repairJobLinks: ${readFailure}`);
    return { ...empty, error: readFailure };
  }

  const jobs = ((data as Job[]) ?? []).filter(
    (j) => j.job_url && !TERMINAL_STATUSES.includes(j.status as never)
  );

  const report: LinkRepairReport = { ...empty };
  for (let i = 0; i < jobs.length; i += BATCH) {
    const results = await Promise.all(jobs.slice(i, i + BATCH).map(repairOne));
    for (const r of results) {
      report.checked++;
      if (r.relinked) report.relinked++;
      if (r.closed) report.closed++;
      if (r.unresolved) report.unresolved++;
      if (r.probablyClosed) report.probablyClosed.push(r.probablyClosed);
    }
  }

  console.log(
    `repairJobLinks: checked ${report.checked}, relinked ${report.relinked}, ` +
      `closed ${report.closed}, probably closed ${report.probablyClosed.length}, ` +
      `unresolved ${report.unresolved}`
  );
  return report;
}

async function repairOne(job: Job): Promise<{
  relinked?: boolean;
  closed?: boolean;
  unresolved?: boolean;
  probablyClosed?: LinkRepairRow;
}> {
  const url = job.job_url as string;
  const out: {
    relinked?: boolean;
    closed?: boolean;
    unresolved?: boolean;
    probablyClosed?: LinkRepairRow;
  } = {};
  let liveUrl = url;

  if (classifyJobLink(url) === "aggregator") {
    const resolved = await resolveEmployerLink(job.company, job.role_title);
    if (resolved?.precision === "posting") {
      const failure = describeWriteFailure(
        (await updateJob(job.id, { job_url: resolved.url })).error,
        `relink ${job.company} / ${job.role_title}`
      );
      if (failure === undefined) {
        out.relinked = true;
        liveUrl = resolved.url;
      } else {
        console.error(`repairJobLinks: ${failure}`);
      }
    } else if (resolved) {
      out.probablyClosed = {
        id: job.id,
        company: job.company,
        role_title: job.role_title,
        boardUrl: resolved.url,
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
