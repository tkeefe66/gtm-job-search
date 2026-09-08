// What kind of link a role's job_url is, and how to guess a company's board
// slug. Pure and import-free: reached from both `"use client"` components and
// server actions.
//
// The one import below is `import type`, which TypeScript erases entirely — no
// runtime edge is added and the file stays client-safe. Duplicating the
// BoardVendor union here instead would let the two lists drift, and the whole
// value of parseBoardLink is that it names vendors lib/ats-boards.ts can fetch.

import type { BoardVendor } from "./ats-boards";

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
  // Added 2026-09-07 after sweeping every distinct job_url host in production
  // against this list and ATS_HOSTS. All three were falling through to
  // `other`, so link health read them as the employer's own careers site and
  // never tried to find a real posting behind them.
  "jobleads.com",
  "themuse.com",
  "remotive.com",
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

/**
 * A specific posting on a vendor whose board API tells the truth.
 *
 * The vendor and the slug are READ out of the stored URL, never guessed from
 * the company name. That is the whole difference between this and
 * `companySlugs` above: `resolveEmployerLink` guesses, so every one of its
 * outcomes has to hedge against having landed on a stranger's board. Here the
 * employer already told us which board this posting lives on, so a board that
 * does not list the posting id is evidence about THIS role rather than about a
 * lookalike company.
 *
 * `id` is the posting's own identifier, and it is what two links to the same
 * req have in common when nothing else does. Host and path do NOT survive a
 * round trip: `/application` and `/apply` steps hang off Ashby and Lever
 * postings, and Greenhouse serves one posting from `boards.greenhouse.io`,
 * `job-boards.greenhouse.io` and the `.eu.` variants of both — so a stored link
 * and the same posting as the API spells it routinely disagree on both.
 * Comparing paths reported those healthy links as missing.
 *
 * CASE IS PRESERVED on the id. Workable and Breezy ids are case-sensitive
 * base62, so lowercasing them would merge distinct postings.
 *
 * `slug` may be EMPTY, for one shape only: Workable's `apply.workable.com/j/<id>`
 * shortlink, which its board API hands back in `shortlink` and which names no
 * company. It is a valid thing to COMPARE against, never a valid thing to look
 * a board up by, so `verifyPostingLink` refuses it as a starting point.
 */
export interface BoardLink {
  vendor: BoardVendor;
  slug: string;
  id: string;
}

/**
 * Reads vendor, slug and posting id out of an employer's own posting link.
 *
 * Non-null ONLY for a DEEP link — a specific posting — on one of the five
 * vendors in BOARD_VENDORS. A bare board page (`jobs.ashbyhq.com/baseten`)
 * returns null: there is no posting id to verify, so there is nothing to say
 * about it. So does every ATS with no honest public board API (Workday,
 * iCIMS, Jobvite, SmartRecruiters, …) — those must keep behaving exactly as
 * they did before this function existed.
 */
export function parseBoardLink(url: string | null | undefined): BoardLink | null {
  const host = hostOf(url);
  if (host === null) return null;

  let path: string;
  try {
    path = new URL(url as string).pathname;
  } catch {
    return null;
  }
  // No `/u` flag and no unicode property escapes: this file is typechecked at
  // the repo's ES5 downlevel target (see CLAUDE.md).
  const parts = path.split("/").filter((p) => p.length > 0).map(decodeSegment);

  // jobs.ashbyhq.com/<slug>/<id>[/application]
  if (host === "jobs.ashbyhq.com") {
    return link("ashby", parts[0], parts.slice(1));
  }

  // job-boards.greenhouse.io/<slug>/jobs/<id>, boards.greenhouse.io/... and the
  // boards.eu./job-boards.eu. regional variants.
  if (matchesHost(host, GREENHOUSE_HOSTS)) {
    return parts[1] === "jobs" ? link("greenhouse", parts[0], parts.slice(2)) : null;
  }

  // jobs.lever.co/<slug>/<id>[/apply], plus the jobs.eu.lever.co variant.
  //
  // BOTH halves are load-bearing. The "jobs." prefix keeps api.lever.co — the
  // board endpoint itself — from being read as a posting. `matchesHost` is what
  // makes the suffix a DOT BOUNDARY: a bare `host.endsWith("lever.co")` accepts
  // `jobs.notlever.co`, a stranger's host, and hands back a slug we would then
  // fetch from Lever's real API — the exact substring hazard CLAUDE.md and
  // matchesHost's own comment both name.
  if (host.indexOf("jobs.") === 0 && matchesHost(host, LEVER_HOSTS)) {
    return link("lever", parts[0], parts.slice(1));
  }

  // apply.workable.com/<slug>/j/<id>/, and the company-less /j/<id> shortlink
  // the board API returns as `shortlink`.
  if (host === "apply.workable.com") {
    if (parts[0] === "j") return link("workable", "", parts.slice(1));
    return parts[1] === "j" ? link("workable", parts[0], parts.slice(2)) : null;
  }

  // <slug>.breezy.hr/p/<id> — the slug is the subdomain, not a path segment.
  if (matchesHost(host, BREEZY_HOSTS)) {
    const slug = host.slice(0, host.length - ".breezy.hr".length);
    // A nested subdomain is not a board slug, and bare breezy.hr has none.
    if (!slug || slug.indexOf(".") !== -1) return null;
    return parts[0] === "p" ? link("breezy", slug, parts.slice(1)) : null;
  }

  return null;
}

const GREENHOUSE_HOSTS = ["greenhouse.io"];
const LEVER_HOSTS = ["lever.co"];
const BREEZY_HOSTS = ["breezy.hr"];

/**
 * Terminal path segments that are a step in the application flow, not part of
 * the posting's identity. `.../<id>/application` and `.../<id>/apply` are the
 * same req as `.../<id>`, and treating them as different ids relinks a healthy
 * row onto itself — or, where the board carries two near-matching titles,
 * reports a LIVE role as ambiguous, which the report offers a "Move to Out"
 * button for.
 */
const APPLY_STEPS = ["apply", "application"];

function link(vendor: BoardVendor, slug: string, idParts: string[]): BoardLink | null {
  const trimmed = idParts.slice();
  while (trimmed.length > 1 && APPLY_STEPS.indexOf(trimmed[trimmed.length - 1].toLowerCase()) !== -1) {
    trimmed.pop();
  }
  // Case is deliberately untouched — see BoardLink.
  const id = trimmed.join("/");
  // A slug-less Workable shortlink is still a posting; a board page is not.
  if (!id || (slug === "" && vendor !== "workable")) return null;
  return { vendor, slug, id };
}

function decodeSegment(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}
