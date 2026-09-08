/**
 * What the "Track a company by name…" box was actually given.
 *
 * The box takes a NAME, and the name is an identity, not a label: it is the
 * key `jobs`, `discovered_roles` and `crawl_runs` are written under, and the
 * value ingestRoles dedupes against. A pasted careers URL stored as-is
 * therefore does not merely look wrong — it becomes the employer, forever,
 * for every role found there.
 *
 * So this reports what it sees and SUGGESTS a name; it never commits one. The
 * suggestion is a guess derived from a host, and this codebase has a standing
 * rule about guessed identifiers (see the BOARD tier in lib/crawler.ts): a
 * guess may be offered to the user, never written on their behalf.
 *
 * ES5 note: no `/u` flag and no `\p{...}` escapes anywhere in this file.
 * tsconfig declares no target, so the build typechecks at ES5 and either one
 * fails it while passing every test. See CLAUDE.md.
 */

export type CompanyInput =
  | { kind: "empty" }
  | { kind: "name"; name: string }
  | { kind: "url"; url: string; suggestion: string };

/**
 * Hosts that belong to an applicant tracking system rather than to an
 * employer. On these the host names the VENDOR and the first path segment
 * names the company, so a host-based reading suggests "Greenhouse" for every
 * employer on Greenhouse.
 *
 * Matched on a dot boundary, never as a substring — lib/job-link.ts records
 * why: a substring check reads a link carrying `?utm_source=lever.co` as the
 * vendor's own.
 */
const ATS_PATH_HOSTS = [
  "greenhouse.io",
  "lever.co",
  "ashbyhq.com",
  "workable.com",
  "breezy.hr",
  "smartrecruiters.com",
  "jobvite.com",
  "recruitee.com",
  "teamtailor.com",
  "applytojob.com",
  "bamboohr.com",
  "paylocity.com",
];

/** Workday puts the employer in a SUBDOMAIN (rtx.wd5.myworkdayjobs.com). */
const ATS_SUBDOMAIN_HOSTS = ["myworkdayjobs.com"];

/** Subdomains that describe the PAGE, not the employer. */
const GENERIC_SUBDOMAINS = [
  "www",
  "careers",
  "career",
  "jobs",
  "job",
  "boards",
  "job-boards",
  "apply",
  "hiring",
  "talent",
  "work",
  "recruiting",
];

/** Path segments that describe the page rather than naming the employer. */
const GENERIC_SEGMENTS = ["jobs", "careers", "embed", "board", "en-us", "en"];

function hostMatches(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith("." + suffix);
}

function titleCase(raw: string): string {
  // Rejoin on the hyphen rather than a space: "well-said" is one word spelled
  // with a hyphen, and "Well Said" is a different company name.
  return raw
    .split("-")
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("-");
}

function looksLikeUrl(raw: string): boolean {
  const lower = raw.toLowerCase();
  if (lower.indexOf("http://") === 0 || lower.indexOf("https://") === 0) return true;
  if (lower.indexOf("www.") === 0) return true;
  // A dotted host FOLLOWED BY A PATH. The path is what makes this a URL rather
  // than a name: "Booking.com" and "Salesforce.com" are companies people type
  // on purpose, and treating any dotted token as a URL would refuse them.
  return /^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)+\/\S*$/.test(lower);
}

function suggestionFrom(parsed: URL): string {
  let host = parsed.hostname.toLowerCase();
  if (host.indexOf("www.") === 0) host = host.slice(4);

  const segments = parsed.pathname
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const vendor of ATS_PATH_HOSTS) {
    if (!hostMatches(host, vendor)) continue;
    const named = segments.find((s) => GENERIC_SEGMENTS.indexOf(s.toLowerCase()) === -1);
    // No path segment means no employer is named. Empty, not a guess at the
    // vendor: the confirm step then asks for a name, which is recoverable.
    return named ? titleCase(named.toLowerCase()) : "";
  }

  for (const vendor of ATS_SUBDOMAIN_HOSTS) {
    if (!hostMatches(host, vendor)) continue;
    const first = host.split(".")[0];
    return first && first !== vendor ? titleCase(first) : "";
  }

  const labels = host.split(".").filter((l) => l.length > 0);
  while (labels.length > 2 && GENERIC_SUBDOMAINS.indexOf(labels[0]) !== -1) {
    labels.shift();
  }
  // Two labels left means host is `employer.tld`; more means a subdomain this
  // list does not know, and the registrable label is still the second-to-last.
  const label = labels.length >= 2 ? labels[labels.length - 2] : labels[0];
  return label ? titleCase(label) : "";
}

export function readCompanyInput(raw: string): CompanyInput {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: "empty" };
  if (!looksLikeUrl(trimmed)) return { kind: "name", name: trimmed };

  // Always carry a scheme out, whatever came in: setCareersUrl requires
  // http(s)://, so handing the raw input back would fail its check on exactly
  // the paste this path exists to rescue.
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    // Looked like a URL and would not parse. Treated as a name rather than
    // refused: the user is the authority on their own employer's name, and
    // there is nothing here to suggest.
    return { kind: "name", name: trimmed };
  }

  return { kind: "url", url: withScheme, suggestion: suggestionFrom(parsed) };
}
