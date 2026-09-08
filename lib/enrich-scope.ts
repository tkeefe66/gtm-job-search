// Which rows the backfill is for, how many one call may touch, and what a
// link's verification permits.
//
// Pure, and out here rather than inside app/actions/enrich.ts, for the reason
// lib/rescore-scope.ts states about itself: these encode decisions that are
// expensive to get wrong and impossible to test through an action that fetches
// pages and calls Claude.

import { bucketFor, type JobStatusDef } from "@/lib/job-statuses";
import type { LinkKind } from "@/lib/job-link";
import type { PostingVerification } from "@/lib/resolve-job-link";
import type { UnclearReason } from "@/lib/link-report";
import { hasPostingBeenRead } from "@/lib/posting-detail";
import type { Job } from "@/lib/types";

/**
 * How many rows one enrich call may touch.
 *
 * Smaller than the rescore's 25 because each row costs a page FETCH as well as
 * a model call, and the whole batch has to answer inside Railway's 300s
 * no-data edge timeout — the bound that actually governs, not a constant
 * anybody picked.
 */
export const DEFAULT_ENRICH_LIMIT = 10;
export const MAX_ENRICH_LIMIT = 40;

/**
 * Clamped rather than trusted: the limit arrives from a client component. A
 * missing or unusable value takes the default instead of erroring — the user
 * asked for a backfill, and refusing one over a bad number helps nobody. Zero
 * becomes one, never zero: a call that touches nothing never drains, and the
 * client's paging loop would run until its batch budget ran out.
 */
export function clampEnrichLimit(n?: number | null): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_ENRICH_LIMIT;
  const whole = Math.floor(n);
  if (whole < 1) return 1;
  return Math.min(whole, MAX_ENRICH_LIMIT);
}

/**
 * The rows a backfill is for: no stored posting detail, a link to read it
 * from, and a status that is not terminal.
 *
 * The terminal filter is the one repairJobLinks uses, for the same reason: a
 * role the user already rejected must not cost a fetch and a billed call.
 *
 * A row stops being thin the moment the posting is READ, so "how many are left"
 * is just this filter re-run — the enrich pass needs no `passStartedAt` twin of
 * the rescore's, because unlike a re-score, an enrich CHANGES what the
 * predicate matches. It also means the queue never permanently empties while
 * searches keep finding roles, which is correct: every new role arrives unread.
 */
export function thinJobs(jobs: Job[], statuses: JobStatusDef[]): Job[] {
  return jobs.filter(
    (j) => !hasPostingBeenRead(j) && !!j.job_url && bucketFor(statuses, j.status) !== "terminal"
  );
}


/** Why a row was not enriched. Never a failure — a refusal. */
export type EnrichBlockReason = UnclearReason | "absent";

/**
 * What may be done with a row, given its link and what its board said.
 *
 * `proceed` fetches the stored URL; `resolve` must find the employer's own
 * posting first; `relink` must WRITE the corrected URL before enriching
 * against it; `blocked` reports and spends nothing.
 */
export type EnrichGate =
  | { kind: "proceed" }
  | { kind: "resolve" }
  | { kind: "relink"; url: string }
  | { kind: "blocked"; reason: EnrichBlockReason };

/**
 * The guardrail. Enriching against a wrong URL writes fiction into the row,
 * which is worse than leaving it thin, so the rule is POSITIVE EVIDENCE OF
 * WRONGNESS — a board that could not be read blocks nothing.
 *
 * The aggregator branch comes FIRST and ignores the verification, which is the
 * whole subtlety: verifyPostingLink answers `notApplicable` for both a company
 * careers site and every aggregator link. Reading that as "proceed" would
 * enrich from a reseller's stale copy — worse than a wrong ATS link, because a
 * reseller answers 200 with plausible content long after the req closed, and
 * CLAUDE.md records that 29 of 61 rows were reseller links.
 */
export function enrichGate(
  linkKind: LinkKind | null,
  verified: PostingVerification
): EnrichGate {
  if (linkKind === null) return { kind: "blocked", reason: "unresolved" };
  if (linkKind === "aggregator") return { kind: "resolve" };
  switch (verified.kind) {
    case "relink":
      return { kind: "relink", url: verified.url };
    case "unclear":
      return { kind: "blocked", reason: verified.reason };
    case "absent":
      return { kind: "blocked", reason: "absent" };
    default:
      // `listed` (the link is fine), `unreachable` (a board we could not read
      // says nothing) and `notApplicable` (a company careers site, or an ATS
      // with no honest board API) all proceed.
      return { kind: "proceed" };
  }
}

/**
 * One batch of thin rows, plus where the next batch resumes.
 *
 * Paged by CURSOR rather than by the rescore's `passStartedAt`, because the
 * two passes leave different traces. An enriched row stops matching `posting
 * is null` on its own; a BLOCKED one never does. Re-reading the thin set each
 * time would therefore hand every later batch the same blocked rows — each
 * costing another board lookup, and the pass never draining. Ordering by id
 * and resuming after the last row DECIDED (enriched, blocked or failed alike)
 * drains in a bounded number of batches whatever each row's outcome was.
 *
 * A fresh pass starts from the beginning and re-examines blocked rows. That is
 * intended: their boards may have changed, and re-checking one costs a board
 * fetch, never a model call.
 */
export function enrichBatch(
  jobs: Job[],
  statuses: JobStatusDef[],
  opts: { limit: number; cursor?: string | null }
): { batch: Job[]; remaining: number; cursor: string | null } {
  const eligible = thinJobs(jobs, statuses)
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .filter((j) => (opts.cursor ? j.id > opts.cursor : true));
  const batch = eligible.slice(0, opts.limit);
  return {
    batch,
    remaining: eligible.length - batch.length,
    // Null when this batch decided nothing, so a client loop cannot restart
    // itself against the same rows.
    cursor: batch.length > 0 ? batch[batch.length - 1].id : null,
  };
}

/**
 * The report app/actions/enrich.ts returns, and lib/enrich-pass.ts accumulates.
 *
 * Defined here rather than in the action for the reason lib/link-report.ts
 * states about LinkRepairRow: the banner that renders it is a client
 * component, and a type imported from a `"use server"` module drags that module
 * into the client graph.
 */
export interface EnrichBlockedRow {
  id: string;
  company: string;
  role_title: string;
  /** Where to send the user for this row: the board we found, or its own link. */
  url: string;
  reason: EnrichBlockReason;
}

export interface EnrichReport {
  /** Rows that gained real posting detail. */
  enriched: number;
  /**
   * Rows the model had nothing usable for. Written anyway — `posting is null`
   * is the thin predicate, so leaving them null re-bills them on every run —
   * and counted apart, so a systematic extraction failure is visible rather
   * than looking like spend.
   */
  empty: number;
  /** Links repaired on the way past the guardrail. */
  relinked: number;
  /** robots.txt said no, the fetch failed, or the page was a JS shell. */
  unreadable: number;
  /** The model refused, the answer would not parse, or a write failed. */
  failed: number;
  /** Rows the guardrail refused, with the reason on each. */
  blocked: EnrichBlockedRow[];
  /** Thin rows this call did not reach. */
  remaining: number;
  /** Where the next page resumes. Null when nothing was decided. */
  cursor: string | null;
  error?: string;
}
