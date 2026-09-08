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
 * A real Lever board is a JSON ARRAY; a missing one is
 * `{"ok":false,"error":"Document not found"}` alongside a 404.
 *
 * The shape check is not redundant with the status check above it. The status
 * is what the transport sees; the shape is what protects against a vendor that
 * returns an error PAYLOAD under a success status, which is not hypothetical —
 * SmartRecruiters' postings endpoint answers 200 with an empty result envelope
 * for companies that do not exist, and is excluded from BOARD_VENDORS for
 * exactly that reason. Two independent gates, cheap, and either one alone has
 * a documented way to be fooled.
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

/** One posting's own words, read off the vendor's board API. */
export interface PostingBody {
  text: string;
  /** The team the vendor files it under, when it publishes one. */
  department: string;
}

/**
 * Where to fetch ONE posting's body, or null when no second call is needed or
 * the vendor's body shape has not been verified.
 *
 * Greenhouse's list endpoint omits `content`, so a posting needs its own call.
 * Ashby's board list already carries `descriptionPlain` for every posting, so
 * asking again would be a second request for data the cached board fetch
 * already holds. The other three are null because nobody has probed them:
 * guessing a body shape here is how a parser starts returning "" for a posting
 * that says plenty, which then gets STORED as "this posting says nothing".
 *
 * Both Greenhouse shapes were control-tested the way BOARD_VENDORS demands: a
 * nonsense slug 404s, and so does a nonsense posting id on a real board.
 */
export function postingBodyUrl(
  vendor: BoardVendor,
  slug: string,
  postingId: string
): string | null {
  switch (vendor) {
    case "greenhouse":
      return `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs/${postingId}`;
    case "workable":
      // The widget board list carries no description at all — title, shortcode,
      // department and links only — so the body needs this second call, keyed
      // by the shortcode parseBoardLink reads out of the stored URL.
      return `https://apply.workable.com/api/v1/accounts/${slug}/jobs/${postingId}`;
    default:
      // Ashby and Lever publish every description in the board payload the link
      // check already fetches; Breezy publishes none and is not guessed at.
      return null;
  }
}

/** Strips tags and collapses whitespace. The vendors publish HTML, not text. */
function htmlToText(html: string): string {
  return decodeEntities(html)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const ENTITY_PATTERN = /&(?:amp|lt|gt|quot|#39|apos|nbsp|#x27|#x2F);/g;
const BODY_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  "&#x27;": "'",
  "&#x2F;": "/",
};

// Twice, deliberately: Greenhouse serves its content DOUBLE-escaped (`&lt;p&gt;`
// arrives where a `<p>` was), so one pass leaves literal tags in the text and
// the model is handed markup as though it were prose.
function decodeEntities(s: string): string {
  const once = s.replace(ENTITY_PATTERN, (m) => BODY_ENTITIES[m] ?? m);
  return once.replace(ENTITY_PATTERN, (m) => BODY_ENTITIES[m] ?? m);
}

/**
 * One posting's body, out of whatever the vendor's endpoint returned.
 *
 * NULL for anything unrecognised — the same rule parseBoard follows, and for a
 * sharper reason here: an empty string would be stored as "this posting says
 * nothing", which is a claim, where null means "we could not read it" and
 * leaves the row thin for a later pass.
 */
export function parsePostingBody(
  vendor: BoardVendor,
  postingId: string,
  json: unknown
): PostingBody | null {
  if (!json || typeof json !== "object") return null;

  if (vendor === "greenhouse") {
    const job = json as { content?: unknown; departments?: unknown };
    if (typeof job.content !== "string") return null;
    const text = htmlToText(job.content);
    if (text === "") return null;
    const departments = Array.isArray(job.departments) ? job.departments : [];
    const first = departments[0] as { name?: unknown } | undefined;
    return { text, department: typeof first?.name === "string" ? first.name : "" };
  }

  if (vendor === "lever") {
    // Lever's board payload is a bare ARRAY, and its requirement bullets live
    // in `lists` rather than in the description — a body built from
    // descriptionPlain alone hands the model the blurb and none of what the
    // posting actually asks for.
    if (!Array.isArray(json)) return null;
    const job = json.find((j) => (j as { id?: unknown })?.id === postingId) as
      | { descriptionPlain?: unknown; lists?: unknown; categories?: unknown }
      | undefined;
    if (!job) return null;
    const parts: string[] = [];
    if (typeof job.descriptionPlain === "string") parts.push(job.descriptionPlain);
    const lists = Array.isArray(job.lists) ? job.lists : [];
    for (const list of lists) {
      const entry = list as { text?: unknown; content?: unknown };
      if (typeof entry.text === "string") parts.push(entry.text);
      if (typeof entry.content === "string") parts.push(htmlToText(entry.content));
    }
    const text = parts.join(" ").replace(/\s+/g, " ").trim();
    if (text === "") return null;
    const team = (job.categories as { department?: unknown } | undefined)?.department;
    return { text, department: typeof team === "string" ? team : "" };
  }

  if (vendor === "workable") {
    // Three fields, and `requirements` is the one that matters most — it is
    // where Workable puts what the posting asks for, and a body built from
    // `description` alone would drop exactly that.
    const job = json as { description?: unknown; requirements?: unknown; benefits?: unknown; department?: unknown };
    const parts = [job.description, job.requirements, job.benefits]
      .filter((v): v is string => typeof v === "string")
      .map(htmlToText);
    const text = parts.join(" ").trim();
    if (text === "") return null;
    return { text, department: typeof job.department === "string" ? job.department : "" };
  }

  if (vendor === "ashby") {
    // The whole board payload, not one posting: Ashby publishes every
    // description in the list the board fetch already cached.
    const jobs = (json as { jobs?: unknown }).jobs;
    if (!Array.isArray(jobs)) return null;
    const job = jobs.find((j) => (j as { id?: unknown })?.id === postingId) as
      | { descriptionPlain?: unknown; descriptionHtml?: unknown; department?: unknown }
      | undefined;
    if (!job) return null;
    const raw =
      typeof job.descriptionPlain === "string"
        ? job.descriptionPlain
        : typeof job.descriptionHtml === "string"
          ? htmlToText(job.descriptionHtml)
          : null;
    if (raw === null || raw.trim() === "") return null;
    return {
      text: raw.trim(),
      department: typeof job.department === "string" ? job.department : "",
    };
  }

  return null;
}
