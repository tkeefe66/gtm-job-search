import { BOARD_VENDORS, boardApiUrl, boardPageUrl, findPosting, parseBoard } from "./ats-boards";
import type { Posting } from "./ats-boards";
import type { BoardVendor } from "./ats-boards";
import { companySlugs, hostOf, parseBoardLink } from "./job-link";

/**
 * Finds the employer's own link for a role we only have a reseller's link to.
 *
 * The narrow ATS-API exception: these are the vendors' PUBLIC board endpoints,
 * no key and no account, returning the same postings the company's own board
 * page shows. Used only to replace a link — never to discover roles, which
 * stays the crawler's HTML path (see CLAUDE.md).
 *
 * Costs nothing per call (no Claude, no billing), so it is safe to run over
 * every aggregator row. It is NOT free in requests: up to
 * vendors × slug-candidates fetches per company, which is why the first board
 * found ends the search.
 */

const TIMEOUT_MS = 8000;

export interface ResolvedLink {
  url: string;
  vendor: BoardVendor;
  slug: string;
  /**
   * `posting` — the exact req, matched by title. `url` is that posting.
   * `absent` — the board exists and nothing on it resembles this title, so the
   *   posting is gone. The only outcome a caller may close a role on.
   * `ambiguous` — the board exists and more than one posting could be this
   *   role. Reported, never acted on: closing here would kill a live role over
   *   a wording difference.
   * `empty` — a board exists under this company's slug but lists NOTHING, on
   *   any vendor. Kept separate from `ambiguous` because the two mean different
   *   things to a human: "several postings look like this" is a disambiguation
   *   task, while "this board is empty" usually means the company hires
   *   somewhere else — or that the slug guess landed on a stranger's board.
   *   Reported under its own sentence, and acted on by no caller.
   *
   * For every non-posting outcome `url` is the company's board page, which is
   * still a better destination than a reseller's expired copy.
   *
   * ONLY `absent` may close a role. Any caller adding a branch here must leave
   * the other three alone — a test in lib/ingest-roles.test.ts pins that
   * `empty` does not close anything.
   */
  precision: "posting" | "absent" | "ambiguous" | "empty";
}

export async function resolveEmployerLink(
  company: string,
  roleTitle: string
): Promise<ResolvedLink | null> {
  // An empty board found early must not end the search: a company can leave a
  // stale, empty board on one vendor while hiring through another (Asseti has
  // an empty Breezy board and eight open roles on Workable). Held aside, used
  // only if nothing better turns up, and reported as `empty` so it can never
  // close a role on its own.
  let emptyBoard: ResolvedLink | null = null;

  for (const slug of companySlugs(company)) {
    for (const vendor of BOARD_VENDORS) {
      const postings = await fetchBoard(vendor, slug);
      // null means "no such board" — keep probing.
      if (postings === null) continue;

      const match = findPosting(postings, roleTitle);
      if (match.kind === "empty") {
        emptyBoard ??= { url: boardPageUrl(vendor, slug), vendor, slug, precision: "empty" };
        continue;
      }
      return match.kind === "posting"
        ? { url: match.posting.url, vendor, slug, precision: "posting" }
        : { url: boardPageUrl(vendor, slug), vendor, slug, precision: match.kind };
    }
  }
  return emptyBoard;
}

/**
 * One pass's board fetches, keyed `vendor:slug`.
 *
 * `upgradeLink` runs inside an unbounded `Promise.all`, so twenty fresh
 * Greenhouse roles at one company fired twenty concurrent byte-identical
 * requests at the same board endpoint — and Discover ingests several companies
 * in parallel on top of that. Nothing is billed, but a rate-limited board
 * answers `unreachable`, which is inert by design and would therefore disable
 * this whole check silently.
 *
 * The PROMISE is cached, not the result: that is what makes concurrent callers
 * share one in-flight request rather than each starting their own.
 *
 * Scoped to a pass rather than the module, deliberately. A module-level cache
 * would need a staleness story — how long a board's contents stay true, and what
 * a "Check links" re-run is supposed to observe after the user fixed something.
 * A pass-scoped map needs none: it lives exactly as long as the question does.
 */
export type BoardCache = Map<string, Promise<Posting[] | null>>;

export function newBoardCache(): BoardCache {
  return new Map();
}

function fetchBoardCached(
  vendor: BoardVendor,
  slug: string,
  cache?: BoardCache
): Promise<Posting[] | null> {
  if (!cache) return fetchBoard(vendor, slug);
  const key = `${vendor}:${slug}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const pending = fetchBoard(vendor, slug);
  cache.set(key, pending);
  return pending;
}

async function fetchBoard(vendor: BoardVendor, slug: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(boardApiUrl(vendor, slug), {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    // 404 is the honest answer for a missing board on Greenhouse and Ashby.
    // Lever answers 200 with an error object instead, which is why the body is
    // parsed rather than trusted — parseBoard returns null for that shape.
    if (!res.ok) return null;
    return parseBoard(vendor, await res.json());
  } catch {
    // A timeout or a body that is not JSON is indistinguishable from an absent
    // board for our purposes: we have nothing better to link to either way.
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Verifying that ONE stored posting link still exists on its own vendor's board.
 *
 * Different question from `resolveEmployerLink` above, and a better-founded one.
 * There the slug is GUESSED from the company name, so every outcome has to hedge
 * against having landed on a stranger's board. Here vendor and slug are READ out
 * of the URL the employer themselves published, so "this board does not carry
 * this posting id" is a fact about this exact role.
 *
 * It exists because two gates both missed a dead Ashby link:
 *  - `checkJobUrl` only closes on a definitive 404/410, and Ashby's posting page
 *    is a client-rendered SPA that answers 200 and then paints "Job not found".
 *  - `upgradeLink` and `repairOne` only consulted a board for AGGREGATOR links,
 *    so an ashbyhq.com URL — classified `ats`, and correctly so, because the HOST
 *    really is the employer — never had its POSTING ID checked against the
 *    employer's own honest board API.
 *
 * Costs no Claude tokens and exactly ONE board fetch.
 */
export type PostingVerification =
  /** Not a deep link on a vendor with an honest board API. Nothing was fetched. */
  | { kind: "notApplicable" }
  /**
   * The board could not be read: a 404, a timeout, a body that is not JSON.
   * Indistinguishable from "the board is gone", so it must stay INERT — the same
   * rule `fetchBoard` returning null already has everywhere else in this file.
   */
  | { kind: "unreachable"; vendor: BoardVendor; slug: string }
  /** The stored URL is on the board. The link is fine. */
  | { kind: "listed"; vendor: BoardVendor; slug: string }
  /**
   * The stored URL is NOT on the board and exactly one posting matches the
   * title. `url` is that posting — the repaired link.
   */
  | { kind: "relink"; vendor: BoardVendor; slug: string; url: string }
  /**
   * The stored URL is not on the board and the title match could not decide:
   * several postings could be this role (`ambiguous`), or the board lists
   * nothing at all (`empty`). `url` is the board page. Reported, never acted on
   * — the same rule `resolveEmployerLink` follows, for the same reason.
   */
  | { kind: "unclear"; vendor: BoardVendor; slug: string; url: string; reason: "ambiguous" | "empty" }
  /**
   * The stored URL is not on the board AND nothing on the board resembles the
   * title. Strong evidence the posting is gone — and deliberately NOT acted on
   * by any caller in this change. Closing a role is what sets `never_live` and
   * what hides it from `/roles`, and this change's job is to point links at the
   * right place, not to widen what closes roles. A later change may act on it;
   * until then it is reported here and does nothing.
   */
  | { kind: "absent"; vendor: BoardVendor; slug: string; url: string };

export async function verifyPostingLink(
  url: string,
  roleTitle: string,
  cache?: BoardCache
): Promise<PostingVerification> {
  const link = parseBoardLink(url);
  // A slug-less Workable shortlink parses — it is a real posting reference —
  // but names no company, so there is no board to look it up on.
  if (!link || !link.slug) return { kind: "notApplicable" };
  const { vendor, slug } = link;

  const postings = await fetchBoardCached(vendor, slug, cache);
  // Inert on purpose: a board we could not read says nothing about the posting.
  if (postings === null) return { kind: "unreachable", vendor, slug };

  if (postings.some((p) => sameLink(p.url, url))) return { kind: "listed", vendor, slug };

  const match = findPosting(postings, roleTitle);
  if (match.kind === "posting") {
    return { kind: "relink", vendor, slug, url: match.posting.url };
  }
  const boardUrl = boardPageUrl(vendor, slug);
  if (match.kind === "absent") return { kind: "absent", vendor, slug, url: boardUrl };
  return { kind: "unclear", vendor, slug, url: boardUrl, reason: match.kind };
}

/**
 * Same posting, compared on IDENTITY rather than on the URL that names it.
 *
 * A stored link and the same posting as the board API spells it disagree
 * constantly, and every disagreement used to read as "the board dropped this
 * posting": Ashby and Lever hang `/application` and `/apply` steps off a
 * posting, Greenhouse serves one req from `boards.greenhouse.io`,
 * `job-boards.greenhouse.io` and the `.eu.` variants of both, and Workable's
 * board API returns a company-less `/j/<hash>` shortlink for a posting stored
 * as `/<slug>/j/<hash>/`. Comparing host+path called all of those missing.
 *
 * That mattered in three escalating ways: a healthy link was rewritten and the
 * `relinked` tally inflated; where the board carried two near-matching titles a
 * LIVE row was reported `ambiguous`, which the report renders with a "Move to
 * Out" button; and where the title had drifted past containment it was reported
 * `absent`, the outcome most likely to be made closable later.
 *
 * `parseBoardLink` already isolates the posting id, so vendor + id is the
 * comparison, with the slug as a free extra gate whenever BOTH sides carry one
 * (the Workable shortlink does not). Both sides come off the same board, fetched
 * by the stored link's own slug, so the slug is established before this is
 * reached — vendor + id is not being asked to distinguish two employers.
 *
 * Host+path is the FALLBACK, for a board URL shaped in some way this parser has
 * never seen. Falling back to the old comparison keeps such a link comparable at
 * all rather than unconditionally missing.
 */
function sameLink(a: string, b: string): boolean {
  const pa = parseBoardLink(a);
  const pb = parseBoardLink(b);
  if (pa && pb) {
    if (pa.vendor !== pb.vendor) return false;
    // Case-sensitive: Workable and Breezy ids are base62.
    if (pa.id !== pb.id) return false;
    // The slug is NOT case-sensitive, and the asymmetry is deliberate. An id
    // identifies a posting inside a board and two ids differing only in case
    // can be two different postings; a slug is a host-path token naming the
    // board itself, and a stored "…/Clay/jobs/4012" is the same board as the
    // API's own "…/clay/jobs/4012". Comparing it case-sensitively re-opens the
    // false-relink this whole identity comparison exists to close.
    return !pa.slug || !pb.slug || pa.slug.toLowerCase() === pb.slug.toLowerCase();
  }

  const ha = hostOf(a);
  const hb = hostOf(b);
  if (ha === null || hb === null) return false;
  return ha === hb && pathOf(a) === pathOf(b);
}

function pathOf(url: string): string {
  try {
    // Trailing slash only — an empty path must stay distinguishable from "/x".
    return new URL(url).pathname.replace(/\/+$/, "").toLowerCase();
  } catch {
    return "";
  }
}
