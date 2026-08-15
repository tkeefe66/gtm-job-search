// Reading a company's public job board, and finding one role on it.
//
// PURE: parsing and matching only. The fetching lives in
// lib/resolve-job-link.ts so every decision made here is testable without a
// network, which matters because the vendors disagree about how to say "no
// such board" (see parseLeverBoard).
//
// These are the vendors' PUBLIC, unauthenticated board endpoints — the same
// postings the company's own board page shows. Narrow exception to the
// "no ATS vendor APIs" rule in CLAUDE.md, which is about how roles are
// DISCOVERED; this is only about replacing a reseller's link with the
// employer's own.

export interface Posting {
  title: string;
  url: string;
}

export type BoardVendor = "greenhouse" | "ashby" | "lever";

export function boardApiUrl(vendor: BoardVendor, slug: string): string {
  switch (vendor) {
    case "greenhouse":
      return `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`;
    case "ashby":
      return `https://api.ashbyhq.com/posting-api/job-board/${slug}`;
    case "lever":
      return `https://api.lever.co/v0/postings/${slug}?mode=json`;
  }
}

/** The company's board page, for when we know the board but not the posting. */
export function boardPageUrl(vendor: BoardVendor, slug: string): string {
  switch (vendor) {
    case "greenhouse":
      return `https://job-boards.greenhouse.io/${slug}`;
    case "ashby":
      return `https://jobs.ashbyhq.com/${slug}`;
    case "lever":
      return `https://jobs.lever.co/${slug}`;
  }
}

/**
 * Every parser returns null for "this is not a board", NOT an empty array.
 *
 * The distinction decides whether we keep probing other vendors: a real board
 * with zero matching roles is an answer, an absent board is not.
 */
export function parseBoard(vendor: BoardVendor, json: unknown): Posting[] | null {
  switch (vendor) {
    case "greenhouse":
      return parseGreenhouseBoard(json);
    case "ashby":
      return parseAshbyBoard(json);
    case "lever":
      return parseLeverBoard(json);
  }
}

function parseGreenhouseBoard(json: unknown): Posting[] | null {
  const jobs = (json as { jobs?: unknown })?.jobs;
  if (!Array.isArray(jobs)) return null;
  return postings(jobs, (j) => [j.title, j.absolute_url]);
}

function parseAshbyBoard(json: unknown): Posting[] | null {
  const jobs = (json as { jobs?: unknown })?.jobs;
  if (!Array.isArray(jobs)) return null;
  // isListed false means the posting exists but is hidden from the board —
  // linking a candidate there is linking them to a page they cannot use.
  return postings(
    jobs.filter((j) => (j as { isListed?: boolean }).isListed !== false),
    (j) => [j.title, j.jobUrl]
  );
}

/**
 * Lever answers a missing board with HTTP 200 and `{"ok":false,"error":...}`,
 * so status alone cannot be trusted — verified against a live slug that does
 * not exist. Shape is the only reliable signal: a real board is a JSON ARRAY.
 */
function parseLeverBoard(json: unknown): Posting[] | null {
  if (!Array.isArray(json)) return null;
  return postings(json, (j) => [j.text, j.hostedUrl]);
}

function postings(
  raw: unknown[],
  pick: (job: Record<string, unknown>) => [unknown, unknown]
): Posting[] {
  const out: Posting[] = [];
  for (const job of raw) {
    if (!job || typeof job !== "object") continue;
    const [title, url] = pick(job as Record<string, unknown>);
    if (typeof title === "string" && typeof url === "string" && title && url) {
      out.push({ title, url });
    }
  }
  return out;
}

/**
 * The posting on this board that IS the role we already have, or null.
 *
 * Exact normalized title first. Failing that, a containment match is accepted
 * ONLY when exactly one posting contains the title (or is contained by it) —
 * a board listing both "GTM Engineer" and "GTM Engineering Manager" is
 * ambiguous, and guessing wrong sends the user to the wrong job, which is a
 * worse outcome than sending them to the board and letting them look.
 */
export function matchPosting(postings: Posting[], roleTitle: string): Posting | null {
  const want = normalizeTitle(roleTitle);
  if (!want) return null;

  const exact = postings.filter((p) => normalizeTitle(p.title) === want);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;

  const near = postings.filter((p) => {
    const got = normalizeTitle(p.title);
    return got.includes(want) || want.includes(got);
  });
  return near.length === 1 ? near[0] : null;
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[''’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
