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

/**
 * Every vendor here was CONTROL-TESTED with a nonsense slug and confirmed to
 * report absence rather than 200. Never add one without running that test:
 * `jobs.ashbyhq.com/<anything>` returns 200 because it is a client-rendered
 * SPA, and SmartRecruiters' postings endpoint returns 200 with an empty
 * envelope for companies that do not exist — either would turn this into a
 * machine that "finds" a board for every company on earth.
 *
 * (Ashby is present because its API is honest; only its HTML lies.
 * SmartRecruiters is absent: its only honest endpoint is a separate
 * company-profile call, and no company in this pipeline uses it. Workday needs
 * a per-tenant site name that cannot be derived from the company name.)
 */
export type BoardVendor = "greenhouse" | "ashby" | "lever" | "workable" | "breezy";

export const BOARD_VENDORS: BoardVendor[] = [
  "greenhouse",
  "ashby",
  "lever",
  "workable",
  "breezy",
];

export function boardApiUrl(vendor: BoardVendor, slug: string): string {
  switch (vendor) {
    case "greenhouse":
      return `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`;
    case "ashby":
      return `https://api.ashbyhq.com/posting-api/job-board/${slug}`;
    case "lever":
      return `https://api.lever.co/v0/postings/${slug}?mode=json`;
    case "workable":
      return `https://apply.workable.com/api/v1/widget/accounts/${slug}?details=true`;
    case "breezy":
      return `https://${slug}.breezy.hr/json`;
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
    case "workable":
      return `https://apply.workable.com/${slug}/`;
    case "breezy":
      return `https://${slug}.breezy.hr/`;
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
    case "workable":
      return parseWorkableBoard(json);
    case "breezy":
      return parseBreezyBoard(json);
  }
}

function parseWorkableBoard(json: unknown): Posting[] | null {
  const jobs = (json as { jobs?: unknown })?.jobs;
  if (!Array.isArray(jobs)) return null;
  // `url` is the public posting; `shortlink` is the apply form. Either lands
  // the user on the employer's page, but url is the one to read first.
  return postings(jobs, (j) => [j.title, j.url ?? j.shortlink]);
}

function parseBreezyBoard(json: unknown): Posting[] | null {
  if (!Array.isArray(json)) return null;
  return postings(json, (j) => [j.name, j.url]);
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
 * `absent` is the load-bearing one: it is the ONLY outcome that lets a caller
 * close a role, so it must mean "nothing on this board even resembles the
 * title", never merely "I couldn't pick between two".
 */
export type PostingMatch =
  | { kind: "posting"; posting: Posting }
  | { kind: "ambiguous" }
  | { kind: "absent" }
  /**
   * A real board carrying no postings at all. NOT the same as `absent`: a
   * company can keep a stale, empty board on one vendor while hiring through
   * another — Asseti has an empty Breezy board AND a Workable board with eight
   * open roles. Treating empty as absence would close live roles on the
   * strength of an abandoned board, so the caller keeps looking instead.
   */
  | { kind: "empty" };

/**
 * Locates a role on a board we already know exists.
 *
 * Exact normalized title first, then containment in either direction — a board
 * saying "Head of Revenue Operations, EMEA" is the same req as a stored "Head
 * of Revenue Operations". More than one candidate is `ambiguous` rather than a
 * guess: a board listing both "GTM Engineer" and "GTM Engineering Manager"
 * cannot tell us which is meant, and sending the user to the wrong job — or
 * worse, CLOSING a live role on that basis — is the failure to avoid.
 *
 * An empty board is its own outcome — see `empty` above. A board with even one
 * posting on it is live enough to trust, which is what makes the Invoca case
 * `absent`: its board carried a "join our talent community" entry and nothing
 * else, so the role really is gone.
 */
export function findPosting(postings: Posting[], roleTitle: string): PostingMatch {
  if (postings.length === 0) return { kind: "empty" };

  const want = normalizeTitle(roleTitle);
  // No title to match on is a question we cannot answer, and answering
  // "absent" would close the role.
  if (!want) return { kind: "ambiguous" };

  const exact = postings.filter((p) => normalizeTitle(p.title) === want);
  if (exact.length === 1) return { kind: "posting", posting: exact[0] };
  if (exact.length > 1) return { kind: "ambiguous" };

  const near = postings.filter((p) => {
    const got = normalizeTitle(p.title);
    return got.includes(want) || want.includes(got);
  });
  if (near.length === 1) return { kind: "posting", posting: near[0] };
  return near.length === 0 ? { kind: "absent" } : { kind: "ambiguous" };
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[''’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
