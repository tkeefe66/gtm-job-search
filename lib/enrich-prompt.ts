// The backfill's extraction prompt: read ONE already-fetched posting and report
// what it says.
//
// Lives here rather than inline in app/actions/enrich.ts for the reason
// buildFitPrompt was moved out of parse-role.ts: `"use server"` forbids
// non-async exports, so a prompt built inside an action is reachable from no
// test in this repo.
//
// Career-neutral by construction. Every tenant shares this text, so an example
// list ("e.g. Salesforce, Marketo") would ship one career's vocabulary to all
// of them — the class lib/career-neutrality.test.ts exists for, and one its
// PHRASES list would miss, since that list only covers strings extracted into
// Profile. The prompt therefore names field SHAPES and never subject matter.

import type { ExtractedPage } from "@/lib/page-extract";

/**
 * How much of a posting is read.
 *
 * A posting page is one document, not a listing, so this is generous — but not
 * unbounded: a fetch that lands on a whole careers site would otherwise put its
 * entire text into a billed prompt.
 */
export const MAX_POSTING_CHARS = 12_000;

export function enrichSystem(): string {
  return (
    "You read a single job posting and report what it says. " +
    "You never add anything the page does not state. " +
    "Return ONLY valid JSON, no markdown, no preamble."
  );
}

export function buildEnrichPrompt(opts: {
  company: string;
  roleTitle: string;
  page: ExtractedPage;
}): string {
  return [
    `Below is the text of a job posting for "${opts.roleTitle}" at ${opts.company}.`,
    "",
    "Return a JSON object with these exact fields:",
    "- requirements (array of strings — what the posting states it requires, " +
      "in the posting's own words, one per entry)",
    "- nice_to_haves (array of strings — preferences the posting states but " +
      "does NOT require, one per entry)",
    "- department (string — the team or function the role sits in, as the " +
      "posting names it)",
    "- description_summary (string — 1-2 sentences on what the role does)",
    "",
    // Both halves matter. Without the first, a model fills gaps from its own
    // knowledge and the row stores fiction, which is worse than staying thin.
    // Without the second, it invents rather than answer empty.
    "Do not invent, infer, or complete anything the page does not state. " +
      "Any field the posting does not cover must come back as an empty array " +
      "or an empty string.",
    "",
    "POSTING TEXT:",
    opts.page.text.slice(0, MAX_POSTING_CHARS),
  ].join("\n");
}
