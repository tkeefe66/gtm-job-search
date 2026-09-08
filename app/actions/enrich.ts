"use server";

import { getJobStatuses, updateJob } from "@/app/actions/jobs";
import {
  clampEnrichLimit,
  enrichBatch,
  enrichGate,
  type EnrichReport,
} from "@/lib/enrich-scope";
import { classifyJobLink } from "@/lib/job-link";
import { withBudget } from "@/lib/metered";
import { readDetail, readPosting } from "@/lib/posting-read";
import { relinkPatch } from "@/lib/relink";
import { requireActor } from "@/lib/require-actor";
import {
  newBoardCache,
  resolveEmployerLink,
  verifyPostingLink,
  type BoardCache,
} from "@/lib/resolve-job-link";
import { readOnboardedAtFor } from "@/lib/settings-store";
import { supabase } from "@/lib/supabase";
import { resolveTenantId } from "@/lib/tenant";
import { describeWriteFailure } from "@/lib/write-failure";
import type { Job } from "@/lib/types";

const EMPTY: EnrichReport = {
  enriched: 0,
  empty: 0,
  relinked: 0,
  unreadable: 0,
  failed: 0,
  blocked: [],
  remaining: 0,
  cursor: null,
};

/**
 * Backfills the posting detail of rows stored before anything extracted it.
 *
 * One plain HTTP fetch and one NON-SEARCH model call per row. It never
 * escalates to the web_search tier: a JS shell yields no text, and falling back
 * to search would silently turn a free-tier backfill into a billed search
 * across the whole table. Such a row is skipped and reported; the user decides.
 *
 * Bounded per BATCH, not per pass. withBudget reserves and checks the ceiling
 * exactly ONCE per call, so N model calls inside one scope pass a single check
 * at row 0 and then bill regardless — and sixty rows of (fetch + call) would
 * not answer inside Railway's 300s no-data edge timeout anyway, losing the
 * report of what was spent. The client pages with the returned cursor.
 */
export async function enrichRoles(opts?: {
  limit?: number;
  cursor?: string | null;
}): Promise<EnrichReport> {
  // Session required, and the onboarding check is the action's OWN. A Server
  // Action is an RPC endpoint addressed by an ID that ships in the client
  // bundle, so requireActorPage()'s redirect on /roles covers nothing here —
  // an un-onboarded tenant could call this directly and bill against it.
  //
  // emptySearchReason is deliberately NOT the gate: it refuses on empty titles,
  // stack terms, locations and fit brain, none of which enrichment reads. It
  // would refuse valid work.
  const actor = await requireActor();
  if ((await readOnboardedAtFor(actor.tenantId)) === null) {
    return {
      ...EMPTY,
      error: "Finish onboarding before enriching roles — there is no profile to read them for.",
    };
  }

  const limit = clampEnrichLimit(opts?.limit);
  const budget = await withBudget({
    action: "enrich",
    // One non-search call per row. Deliberately a per-BATCH estimate: the
    // reservation is a floor for this call only, and the caller loops.
    estimateCents: limit,
    isAdmin: actor.isAdmin,
    fn: () => enrichRolesInner(limit, opts?.cursor ?? null),
  });
  // A cap is a refusal, not a failure.
  if (budget.capped) return { ...EMPTY, error: budget.capped };
  if (budget.error !== undefined) return { ...EMPTY, error: budget.error };
  return budget.result!;
}

async function enrichRolesInner(limit: number, cursor: string | null): Promise<EnrichReport> {
  const { data, error } = await supabase.forTenant(await resolveTenantId()).from("jobs").select("*");
  // Presence, not truthiness: an unreachable database rejects with an EMPTY
  // message, and reading that as success would report "0 rows, all enriched"
  // for a table nobody could see.
  const readFailure = describeWriteFailure(error?.message, "read your roles to enrich them");
  if (readFailure !== undefined) {
    console.error(`enrichRoles: ${readFailure}`);
    return { ...EMPTY, error: readFailure };
  }

  // A failed config read must not be bucketed on the defaults as though the
  // terminal set were known — this decides which rows cost money.
  const { statuses, error: statusesError } = await getJobStatuses();
  if (statusesError !== undefined) {
    const failure = describeWriteFailure(statusesError, "read your status settings to enrich roles");
    console.error(`enrichRoles: ${failure}`);
    return { ...EMPTY, error: failure };
  }

  const { batch, remaining, cursor: nextCursor } = enrichBatch((data as Job[]) ?? [], statuses, {
    limit,
    cursor,
  });

  const report: EnrichReport = { ...EMPTY, blocked: [], remaining, cursor: nextCursor };
  // One cache for the pass: several roles at one company ask one board.
  const boards = newBoardCache();
  // Serial, unlike the rescore's Promise.all: every row here also FETCHES a
  // page, and several rows at one employer would otherwise hit the same host
  // at once — the behaviour a robots gate exists to avoid being rude about.
  for (const job of batch) {
    await enrichOne(job, boards, report);
  }

  console.log(
    `enrichRoles: batch of ${batch.length} (limit ${limit}) — enriched ${report.enriched}, ` +
      `${report.empty} with nothing to store, ${report.relinked} relinked, ` +
      `${report.unreadable} unreadable, ${report.failed} failed, ` +
      `${report.blocked.length} blocked, ${remaining} still to do`
  );
  return report;
}

async function enrichOne(job: Job, boards: BoardCache, report: EnrichReport): Promise<void> {
  const url = job.job_url as string;
  const kind = classifyJobLink(url);
  // An ATS deep link names its own vendor and slug, so the board can be asked
  // about this exact posting. Aggregator links never reach this: enrichGate
  // routes them to the employer's board first, because verifyPostingLink
  // answers `notApplicable` for them and "proceed" would read a reseller's
  // stale copy.
  const verified =
    kind === "ats" ? await verifyPostingLink(url, job.role_title, boards) : { kind: "notApplicable" as const };

  const gate = enrichGate(kind, verified);
  let target = url;

  if (gate.kind === "blocked") {
    report.blocked.push({
      id: job.id,
      company: job.company,
      role_title: job.role_title,
      url: verified.kind === "unclear" || verified.kind === "absent" ? verified.url : url,
      reason: gate.reason,
    });
    return;
  }

  if (gate.kind === "resolve") {
    const resolved = await resolveEmployerLink(job.company, job.role_title);
    if (resolved?.precision !== "posting") {
      report.blocked.push({
        id: job.id,
        company: job.company,
        role_title: job.role_title,
        url,
        reason: "unresolved",
      });
      return;
    }
    if (!(await writeRelink(job, url, resolved.url, report))) return;
    target = resolved.url;
  }

  if (gate.kind === "relink") {
    // Written BEFORE the fetch: enriching against a corrected URL that was
    // never stored would attach one posting's words to a row still pointing at
    // another.
    if (!(await writeRelink(job, url, gate.url, report))) return;
    target = gate.url;
  }

  // The crawler's own rule, and the reason fetchAllowed and fetchPage now live
  // in one module: a robots.txt that could not be READ is not permission, and
  // the gate runs BEFORE the fetch, never after.
  // The read itself is shared with ingest — see lib/posting-read.ts. Two
  // copies would drift on exactly the parts that are invisible when wrong: the
  // robots gate, the page-then-board order, and the refusal to escalate.
  const read = await readPosting({
    url: target,
    company: job.company,
    roleTitle: job.role_title,
    label: "enrichRoles",
  });
  if (read.kind === "unreadable") {
    report.unreadable++;
    return;
  }
  if (read.kind === "failed") {
    report.failed++;
    return;
  }

  const { department, summary } = read;
  const patch: Partial<Job> = {
    // Stamped so the rescore offer can tell which rows gained inputs since the
    // last pass, AND so the row leaves the thin queue. Written even when the
    // answer was empty — see EnrichReport.
    posting: readDetail(read),
  };
  // Only ever FILLS. An empty answer must not blank a column a human, or an
  // earlier ingest, already filled.
  if (department !== "" && !job.department) patch.department = department;
  if (summary !== "" && !job.key_skills) patch.key_skills = summary;

  const failure = describeWriteFailure(
    (await updateJob(job.id, patch)).error,
    `store what ${job.company} / ${job.role_title} says`
  );
  if (failure !== undefined) {
    console.error(`enrichRoles: ${failure}`);
    report.failed++;
    return;
  }
  if (read.empty) report.empty++;
  else report.enriched++;
}

/** Writes a repaired link. False means the row must not be enriched. */
async function writeRelink(
  job: Job,
  from: string,
  to: string,
  report: EnrichReport
): Promise<boolean> {
  // relinkPatch, not a third copy of the first-relink-only rule — see
  // lib/relink.ts.
  const failure = describeWriteFailure(
    (await updateJob(job.id, relinkPatch(job, from, to))).error,
    `relink ${job.company} / ${job.role_title}`
  );
  if (failure !== undefined) {
    console.error(`enrichRoles: ${failure}`);
    report.failed++;
    return false;
  }
  report.relinked++;
  return true;
}
