import {
  boardApiUrl,
  boardPageUrl,
  findPosting,
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
   * `posting` — the exact req, matched by title. `url` is that posting.
   * `absent` — the board exists and nothing on it resembles this title, so the
   *   posting is gone. The only outcome a caller may close a role on.
   * `ambiguous` — the board exists and more than one posting could be this
   *   role. Reported, never acted on: closing here would kill a live role over
   *   a wording difference.
   *
   * For both non-posting outcomes `url` is the company's board page, which is
   * still a better destination than a reseller's expired copy.
   */
  precision: "posting" | "absent" | "ambiguous";
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

      const match = findPosting(postings, roleTitle);
      return match.kind === "posting"
        ? { url: match.posting.url, vendor, slug, precision: "posting" }
        : { url: boardPageUrl(vendor, slug), vendor, slug, precision: match.kind };
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
