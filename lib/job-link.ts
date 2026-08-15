// What kind of link a role's job_url is, and how to guess a company's board
// slug. Pure and import-free: reached from both `"use client"` components and
// server actions.

/**
 * `ats` — the employer's own posting, hosted by an applicant tracking system.
 * `aggregator` — a job board reselling someone else's posting.
 * `other` — anything else, which in practice is the company's own domain.
 *
 * `other` is deliberately NOT "bad". elevenlabs.io/careers and
 * remote.com/jobs are the employer speaking for themselves, exactly what an
 * ATS link is; they simply don't run on a vendor we recognize. Only
 * `aggregator` is a link worth replacing.
 */
export type LinkKind = "ats" | "aggregator" | "other";

/**
 * Hosts that serve employer-hosted job boards. Suffix-matched against the
 * hostname, so `job-boards.greenhouse.io` and `boards.eu.greenhouse.io` both
 * count without listing every subdomain.
 */
export const ATS_HOSTS = [
  "greenhouse.io",
  "ashbyhq.com",
  "lever.co",
  "myworkdayjobs.com",
  "workday.com",
  "jobvite.com",
  "smartrecruiters.com",
  "workable.com",
  "breezy.hr",
  "icims.com",
  "jazzhr.com",
  "applytojob.com",
  "recruitee.com",
  "bamboohr.com",
  "paylocity.com",
  "teamtailor.com",
  "pinpointhq.com",
  "rippling.com",
  "ripplingats.com",
  "taleo.net",
  "eightfold.ai",
  "phenompeople.com",
] as const;

/**
 * Hosts that republish other people's postings.
 *
 * `remote.com` is deliberately ABSENT: Remote is a company in this pipeline and
 * remote.com/jobs is its own careers site, so listing it here would flag the
 * employer's own link as a middleman. Judge a host by whether it resells
 * postings, not by whether it looks like a job site.
 */
export const AGGREGATOR_HOSTS = [
  "ziprecruiter.com",
  "indeed.com",
  "linkedin.com",
  "glassdoor.com",
  "builtin.com",
  "builtincolorado.com",
  "builtinnyc.com",
  "builtinsf.com",
  "builtinaustin.com",
  "builtinchicago.org",
  "builtinboston.com",
  "builtinla.com",
  "builtinseattle.com",
  "lensa.com",
  "theladders.com",
  "tealhq.com",
  "himalayas.app",
  "edtech.com",
  "dice.com",
  "monster.com",
  "simplyhired.com",
  "talent.com",
  "jooble.org",
  "adzuna.com",
  "jobright.ai",
  "wellfound.com",
  "welcometothejungle.com",
  "otta.com",
  "snagajob.com",
  "careerbuilder.com",
] as const;

/** null when there is no usable URL at all — not the same as `other`. */
export function classifyJobLink(url: string | null | undefined): LinkKind | null {
  const host = hostOf(url);
  if (host === null) return null;
  if (matchesHost(host, ATS_HOSTS)) return "ats";
  if (matchesHost(host, AGGREGATOR_HOSTS)) return "aggregator";
  return "other";
}

/** The bare hostname for display ("ziprecruiter.com"), or null. */
export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.hostname.replace(/^www\./, "").toLowerCase();
}

/**
 * Suffix match on a dot boundary, never a substring of the whole URL.
 *
 * `url.includes("lever.co")` would classify a ZipRecruiter link carrying
 * `?utm_source=lever.co` as the employer's own posting, and
 * "notlever.co" is a different site than "lever.co".
 */
function matchesHost(host: string, list: readonly string[]): boolean {
  return list.some((h) => host === h || host.endsWith(`.${h}`));
}

/**
 * Board slugs to try for a company name, best guess first.
 *
 * Vendors disagree on how a two-word name becomes a slug — Greenhouse tends to
 * squash ("candidhealth"), others hyphenate — so both spellings are offered and
 * the caller asks the vendor which one exists. Legal suffixes are dropped
 * because no board is ever at "/acmeinc".
 */
export function companySlugs(company: string): string[] {
  const cleaned = company
    .toLowerCase()
    .replace(/[''’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(inc|llc|ltd|corp|corporation|co|gmbh|plc|sa|ag)\b/g, " ")
    .trim();
  if (!cleaned) return [];

  // No Set spread: this file is compiled under the repo's ES5 downlevel target.
  const squashed = cleaned.replace(/ /g, "");
  const hyphenated = cleaned.replace(/ +/g, "-");
  return squashed === hyphenated ? [squashed] : [squashed, hyphenated];
}
