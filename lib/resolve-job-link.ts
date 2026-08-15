import {
  boardApiUrl,
  boardPageUrl,
  matchPosting,
  parseBoard,
  type BoardVendor,
} from "./ats-boards";
import { companySlugs } from "./job-link";

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
const VENDORS: BoardVendor[] = ["greenhouse", "ashby", "lever"];

export interface ResolvedLink {
  url: string;
  vendor: BoardVendor;
  slug: string;
  /**
   * `posting` — the exact req, matched by title.
   * `board` — the company's board exists but this role is not on it, which is
   * itself a finding: the posting is very likely closed.
   */
  precision: "posting" | "board";
}

export async function resolveEmployerLink(
  company: string,
  roleTitle: string
): Promise<ResolvedLink | null> {
  for (const slug of companySlugs(company)) {
    for (const vendor of VENDORS) {
      const postings = await fetchBoard(vendor, slug);
      // null means "no such board" — keep probing. [] means a real board with
      // nothing on it, which is an answer: stop and report board-level.
      if (postings === null) continue;

      const hit = matchPosting(postings, roleTitle);
      return hit
        ? { url: hit.url, vendor, slug, precision: "posting" }
        : { url: boardPageUrl(vendor, slug), vendor, slug, precision: "board" };
    }
  }
  return null;
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
