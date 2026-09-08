import {
  BOARD_VENDORS,
  boardApiUrl,
  boardPageUrl,
  findPosting,
  parseBoard,
  boardIdentityFrom,
  boardIdentityUrl,
  parsePostingBody,
  postingBodyUrl,
} from "./ats-boards";
import type { PostingBody } from "./ats-boards";
import type { Posting } from "./ats-boards";
import type { BoardVendor } from "./ats-boards";
import { companySlugs, hostOf, parseBoardLink } from "./job-link";
import type { BoardResolution } from "./board-source";

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

/**
 * One posting's own words, straight from the employer's board API.
 *
 * The fetch tier's blind spot, measured: a pass over 60 rows skipped 21 as JS
 * shells, and Greenhouse (19 of the remaining queue) and Ashby (8) are exactly
 * the vendors whose posting PAGES are client-rendered while their board APIs
 * answer honestly. Reading the body there is not the "no ATS APIs" rule being
 * bent — that rule is about how roles are DISCOVERED, and nothing here finds a
 * role. It reads one we already have, and costs no Claude tokens.
 *
 * Null for every vendor whose body shape has not been probed, for a link that
 * names no posting, and for a board that would not answer. Never "" — an empty
 * body would be STORED as "this posting says nothing".
 */
export async function fetchPostingBody(url: string): Promise<PostingBody | null> {
  const link = parseBoardLink(url);
  if (!link || !link.slug || !link.id) return null;

  // Greenhouse and Workable omit the body from their list endpoints, so a
  // posting needs its own call there; Ashby and Lever publish every description
  // in the board payload, so the board URL IS the body source for them. Breezy
  // has no verified shape and is not guessed at.
  const endpoint =
    postingBodyUrl(link.vendor, link.slug, link.id) ??
    (link.vendor === "ashby" || link.vendor === "lever"
      ? boardApiUrl(link.vendor, link.slug)
      : null);
  if (endpoint === null) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(endpoint, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    // Both vendors 404 honestly for a missing board AND for a missing posting
    // id on a real board — control-tested, the standard BOARD_VENDORS demands.
    if (!res.ok) return null;
    return parsePostingBody(link.vendor, link.id, await res.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * The employer's board for a whole COMPANY, for enumeration rather than repair.
 *
 * Two ways in, and they are not equally trustworthy — see lib/board-source.ts
 * for why the distinction decides what may be done with the result:
 *
 * 1. READ: a URL this company already has a row for is an ATS deep link, so
 *    `parseBoardLink` takes the vendor and slug straight out of it. That board
 *    is certainly the employer's.
 * 2. GUESSED: `companySlugs` × `BOARD_VENDORS`, accepted only when a board
 *    answers with postings. That proves the vendor is honest, never that the
 *    board belongs to this company — which is why `boardTrust` then demands
 *    corroboration before such a board may create rows.
 *
 * Costs no Claude tokens. The guessed path is up to slugs × vendors sequential
 * fetches, so callers should prefer a stored URL and cache the outcome for the
 * life of their pass.
 */
export async function resolveBoardForCompany(
  company: string,
  storedUrls: (string | null | undefined)[]
): Promise<{ resolution: BoardResolution; postings: Posting[] } | null> {
  for (const url of storedUrls) {
    const link = parseBoardLink(url);
    if (!link || !link.slug) continue;
    const postings = await fetchBoard(link.vendor, link.slug);
    if (postings === null) continue;
    return {
      resolution: { vendor: link.vendor, slug: link.slug, source: "read" },
      postings,
    };
  }

  for (const slug of companySlugs(company)) {
    for (const vendor of BOARD_VENDORS) {
      const postings = await fetchBoard(vendor, slug);
      // An EMPTY board is not a resolution here, unlike in link repair: there
      // is nothing to enumerate and nothing to corroborate against, and
      // accepting it would let a stranger's empty board stand in for this
      // company's real one.
      if (postings === null || postings.length === 0) continue;
      return { resolution: { vendor, slug, source: "guessed" }, postings };
    }
  }
  return null;
}

/**
 * The employer's own name for a board, for corroborating a GUESSED slug.
 *
 * One fetch, no Claude tokens, and independent of where the board's postings
 * are hosted — see boardIdentityUrl for why that independence is the point.
 */
export async function fetchBoardIdentity(
  vendor: BoardVendor,
  slug: string
): Promise<string | null> {
  const url = boardIdentityUrl(vendor, slug);
  if (url === null) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    return boardIdentityFrom(await res.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
