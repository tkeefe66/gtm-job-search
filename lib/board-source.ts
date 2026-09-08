// Sourcing roles from an employer's own board, and the rules that decide when
// that is allowed.
//
// The distinction this file exists for: a slug READ out of an employer's own
// posting URL names a board that is certainly theirs; a slug GUESSED from a
// company name may name anyone's. Everywhere else in this codebase a wrong
// guess produces a bad LINK on a row that already exists, and every consumer
// hedges accordingly. Enumeration is different in kind — a wrong guess CREATES
// ROWS: a stranger's postings under this company's name, live so they pass the
// URL check, then scored, billed, stored, and eligible to be auto-filed and to
// feed closure evidence. Both reviews of the sourcing spec flagged this as the
// design's central hazard.

import { companyIdentityKey } from "@/lib/role-key";
import type { BoardVendor, Posting } from "@/lib/ats-boards";
import type { Role } from "@/lib/types";

export interface BoardResolution {
  vendor: BoardVendor;
  slug: string;
  /**
   * How this board was found. `read` means `parseBoardLink` took the vendor and
   * slug out of a URL the employer itself published; `guessed` means
   * `companySlugs` produced it from the company's name.
   */
  source: "read" | "guessed";
}

/** What a resolution may be used for. */
export type BoardTrust = "source" | "refuse";

/**
 * Whether this board may create roles for this company.
 *
 * A READ slug always may — it was never a guess. A GUESSED slug may only when
 * the board itself names the employer and that name agrees: Greenhouse
 * publishes `company_name` on every posting, which is the one free corroborator
 * available. Ashby, Lever and Workable publish none, so a guess there has
 * nothing to check against and is refused — "the board is not empty" proves the
 * vendor is honest (the control-test doctrine in lib/ats-boards.ts), never that
 * the board belongs to this company.
 *
 * Agreement is `companyIdentityKey`, so a legal suffix or different casing is
 * not treated as disagreement.
 */
export function boardTrust(
  resolution: BoardResolution,
  company: string,
  declaredNames: string[]
): BoardTrust {
  if (resolution.source === "read") return "source";
  const wanted = companyIdentityKey(company);
  const declared = declaredNames.map(companyIdentityKey).filter((n) => n !== "");
  if (declared.length === 0) return "refuse";
  return declared.some((n) => n === wanted) ? "source" : "refuse";
}

/**
 * Seniority and grammar, dropped so a configured title matches the WORK rather
 * than the level. "Director of Revenue Operations" is a search for revenue
 * operations, not specifically for a Director — the fit score is what judges
 * level, and a board's own titles use whatever ladder that company uses.
 */
const TITLE_NOISE = new Set([
  "of", "the", "and", "for", "a", "an", "to", "in", "at", "or",
  "head", "vp", "vice", "president", "director", "senior", "sr", "staff",
  "principal", "lead", "manager", "chief", "global", "regional", "i", "ii",
]);

/** A title's words, minus punctuation, seniority and grammar. */
function meaningfulWords(title: string): string[] {
  const words = title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== "" && !TITLE_NOISE.has(w));
  return Array.from(new Set(words));
}

/**
 * The board's postings as roles, filtered to what the user is looking for.
 *
 * Filtered HERE rather than at ingest, because `ingestRoles` fans out unbounded
 * `Promise.all`s for liveness checks and scoring: a 400-posting board would
 * issue 400 concurrent requests and ~400 model calls inside one request that
 * Railway closes after 300s.
 *
 * The match is loose on both sides and deliberately unlike `findPosting`'s.
 * That one decides whether a stored link is still listed, where a false
 * positive could close a live role, so it is strict. This one decides whether
 * to LOOK at a posting, where a false negative silently loses a good role — the
 * idiosyncratic titles ("Business Systems Manager") that role search exists to
 * catch. No terms configured keeps everything, because an empty filter means
 * "the user has not narrowed this", not "the user wants nothing".
 */
export function rolesFromBoard(postings: Posting[], titleTerms: string[]): Role[] {
  const groups = titleTerms.map(meaningfulWords).filter((w) => w.length > 0);
  const wanted = postings.filter((p) => {
    if (groups.length === 0) return true;
    const words = new Set(meaningfulWords(p.title));
    // ALL of some configured title's meaningful words, in any order. Substring
    // matching was measured against a real 89-posting board and found NOTHING:
    // users configure phrases ("Director of Revenue Operations") and boards
    // publish titles ("Marketing Platform Operations Manager"). One shared word
    // is too loose — it lets every "Operations" role through.
    return groups.some((group) => group.every((w) => words.has(w)));
  });
  return wanted.map((p) => ({
    role_title: p.title,
    job_url: p.url,
    // Everything else comes from READING the posting, which ingestRoles does
    // per role. A board listing is an index, not a description.
    location: "",
    seniority: "",
    salary_range: "",
    description_summary: "",
    fit_signal: "",
    ic_flag: false,
  }));
}
