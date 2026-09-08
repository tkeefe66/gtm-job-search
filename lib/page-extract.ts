// Turns fetched careers-page HTML into text an LLM can extract roles from,
// and decides whether the page had any content at all.
//
// A "JS shell" is a careers page whose HTML contains no jobs because the board
// is rendered client-side by an ATS embed. Those pages must fall back to the
// web_search tier. Erring toward "shell" is safe — the search tier is strictly
// more capable, just more expensive.

export const MAX_PAGE_CHARS = 40_000;
const MIN_CONTENT_CHARS = 500;
const MIN_JOB_LINKS = 3;

export const JOB_LINK_PATTERN =
  /\/job|\/jobs\/|\/careers\/|\/position|\/opening|gh_jid=|\/apply/i;

export interface PageLink {
  href: string;
  text: string;
}

export interface ExtractedPage {
  text: string;
  links: PageLink[];
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] ?? m);
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function stripHtml(html: string): ExtractedPage {
  // Drop chrome and non-content elements wholesale, including their markup.
  const body = html.replace(
    /<(script|style|svg|noscript|nav|footer|header)\b[^>]*>[\s\S]*?<\/\1>/gi,
    " "
  );

  const links: PageLink[] = [];
  const anchor = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchor.exec(body)) !== null) {
    links.push({
      href: decodeEntities(match[1]),
      text: collapse(decodeEntities(match[2].replace(/<[^>]+>/g, " "))),
    });
  }

  const text = collapse(decodeEntities(body.replace(/<[^>]+>/g, " "))).slice(
    0,
    MAX_PAGE_CHARS
  );

  return { text, links };
}

export function isJsShell(page: ExtractedPage): boolean {
  if (page.text.length < MIN_CONTENT_CHARS) return true;
  const jobLinks = page.links.filter((l) => JOB_LINK_PATTERN.test(l.href));
  return jobLinks.length < MIN_JOB_LINKS;
}

/**
 * Reads a SINGLE POSTING page, the backfill's equivalent of the crawler's
 * classifyFetchOutcome.
 *
 * Separate from isJsShell, and it must stay separate: isJsShell's second clause
 * requires three job LINKS, which is the right question for a careers listing
 * and the wrong one for a posting — a posting page links to one job, its own,
 * and often to none. Judging postings with it classified every real one as a
 * shell and skipped the whole table.
 *
 * What remains is the length test, which is the part that actually detects an
 * unrendered SPA: a client-rendered shell serves almost no text at all.
 */
export function readPostingPage(
  html: string
): { kind: "shell" } | { kind: "content"; page: ExtractedPage } {
  const page = stripHtml(html);
  return page.text.length < MIN_CONTENT_CHARS ? { kind: "shell" } : { kind: "content", page };
}
