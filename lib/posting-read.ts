// Reading ONE posting and turning it into stored detail.
//
// Shared by both callers on purpose, because they are the same operation at two
// moments: lib/ingest-roles.ts reads a role's posting BEFORE it is scored, and
// app/actions/enrich.ts reads the ones that were stored before this existed (or
// whose read failed the first time). Two copies would drift on the parts that
// are easy to get wrong and invisible when wrong — the robots gate, the
// page-then-board order, and the refusal to escalate to search.

import { buildEnrichPrompt, enrichSystem } from "@/lib/enrich-prompt";
import { fetchAllowed, fetchPage } from "@/lib/fetch-page";
import { callStructured, parseJson } from "@/lib/model-call";
import { readPostingPage } from "@/lib/page-extract";
import { postingDetailFrom, type PostingDetail } from "@/lib/posting-detail";
import { fetchPostingBody } from "@/lib/resolve-job-link";

export type PostingRead =
  /** The posting was read and the model answered. */
  | {
      kind: "read";
      detail: PostingDetail;
      /** The team, from the model or (failing that) the vendor's own filing. */
      department: string;
      /** 1-2 sentences on what the role does. */
      summary: string;
      /** True when nothing usable came back — a real answer, not a failure. */
      empty: boolean;
    }
  /** No text to read: robots said no, the page would not load, or it was a shell with no board body. */
  | { kind: "unreadable" }
  /** There was text, and the model or the parse failed on it. */
  | { kind: "failed"; message: string };

/**
 * Reads a posting, or says why it could not.
 *
 * Costs one NON-SEARCH model call when there is text, and nothing when there is
 * not. It must NEVER escalate to the web_search tier: a JS shell yields no
 * text, and falling back to search would silently turn a free read into a
 * billed search everywhere this is called — which, since ingest calls it, is
 * every crawl and every role search.
 */
export async function readPosting(opts: {
  url: string;
  company: string;
  roleTitle: string;
  /** For the log line, so a crawl and a backfill are distinguishable. */
  label: string;
}): Promise<PostingRead> {
  // The crawler's own rule, and the reason fetchAllowed and fetchPage live in
  // one module: a robots.txt that could not be READ is not permission, and the
  // gate runs BEFORE the fetch, never after.
  const allowed = await fetchAllowed(opts.url);
  if (!allowed) {
    console.log(`${opts.label}: robots.txt disallows (or could not be read for) ${opts.url}`);
  }

  // readPostingPage, NOT the crawler's classifyFetchOutcome: that one also
  // requires three job LINKS, which a single posting page has no reason to
  // carry, so it calls every real posting a shell.
  const html = allowed ? await fetchPage(opts.url) : null;
  const fromPage = html === null ? null : readPostingPage(html);

  // The page FIRST, the board API only as the fallback: where a posting renders
  // server-side its own page is the fuller document, and the board's body is
  // what the vendor chose to publish.
  let text: string;
  let boardDepartment = "";
  if (fromPage?.kind === "content") {
    text = fromPage.page.text;
  } else {
    // Reached when robots disallowed the PAGE too, and that is deliberate: a
    // board API is a different host publishing the same posting deliberately,
    // and link repair already queries it for every row. What robots governs is
    // crawling the employer's site, which this branch does not do. If that ever
    // stops being true, this is the line to change — not fetchAllowed, which
    // the crawler shares.
    const body = await fetchPostingBody(opts.url);
    if (body === null) {
      console.log(
        `${opts.label}: ${opts.company} / ${opts.roleTitle} could not be read ` +
          `(${fromPage === null ? "no page" : "JS shell"}, no board body)`
      );
      return { kind: "unreadable" };
    }
    text = body.text;
    // The vendor's own filing, used only where the posting text yields none.
    boardDepartment = body.department;
  }

  let answer: {
    requirements?: unknown;
    nice_to_haves?: unknown;
    department?: unknown;
    description_summary?: unknown;
  };
  try {
    const raw = await callStructured({
      system: enrichSystem(),
      prompt: buildEnrichPrompt({
        company: opts.company,
        roleTitle: opts.roleTitle,
        page: { text, links: [] },
      }),
      maxTokens: 2000,
    });
    answer = parseJson(raw);
  } catch (err) {
    // Not describeWriteFailure: this failure is the model or the parse, and
    // UNDESCRIBED_DB_ERROR names the database, which would be a false sentence.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${opts.label}: ${opts.company} / ${opts.roleTitle} — ${message}`);
    return { kind: "failed", message };
  }

  const detail = postingDetailFrom(answer);
  const department =
    (typeof answer.department === "string" ? answer.department.trim() : "") || boardDepartment;
  const summary =
    typeof answer.description_summary === "string" ? answer.description_summary.trim() : "";
  return {
    kind: "read",
    detail,
    department,
    summary,
    empty:
      detail.requirements.length === 0 &&
      detail.niceToHaves.length === 0 &&
      department === "" &&
      summary === "",
  };
}

/** Stamps a read as having happened, which is what takes a row out of the thin queue. */
export function readDetail(read: { detail: PostingDetail }, now = new Date()): PostingDetail {
  return { ...read.detail, enrichedAt: now.toISOString() };
}
