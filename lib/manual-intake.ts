// Adding a role by hand: the decisions, separated from the action that fetches.
//
// URL first, paste as the fallback. The URL is preferred for a reason that is
// about IDENTITY rather than convenience: pasted text carries no employer, no
// canonical link and no posting id, so it cannot be deduped against existing
// rows, re-checked for liveness, or attributed without the user typing what the
// URL would have supplied. The paste box exists because some hosts — Indeed,
// ZipRecruiter, LinkedIn, Workday tenants — block automated readers in
// principle, and no sourcing change ever reaches them.

/**
 * The URL as it should be stored, or null when the input is not a URL.
 *
 * Normalised so one posting cannot become two rows through a trailing slash or
 * a stray space, and a missing scheme is assumed rather than refused — people
 * paste `jobs.example.com/x` constantly.
 */
export function normalizeIntakeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  // A scheme that is not http(s) is refused BEFORE the https:// prefix is
  // assumed, or "mailto:someone@example.com" becomes
  // "https://mailto:someone@example.com" — which parses, with host
  // "example.com", and would be fetched.
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
  if (scheme && !/^https?$/i.test(scheme[1])) return null;
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!parsed.hostname.includes(".")) return null;
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${path}${parsed.search}`;
}

/**
 * Who this role is, from the page and whatever the user typed.
 *
 * The user wins where they typed something: they can see the page, and a
 * posting's structured data is regularly stale or generic. Where neither
 * supplies a name, intake must ASK — a row with no company or no title cannot
 * be deduped, scored, or displayed sensibly, and inventing one from the URL
 * would put a hostname in front of the user as a company.
 */
export function intakeIdentity(
  read: { title: string; employer: string },
  typed: { company?: string; roleTitle?: string }
): { company: string; roleTitle: string; complete: boolean } {
  const company = (typed.company ?? "").trim() || read.employer.trim();
  const roleTitle = (typed.roleTitle ?? "").trim() || read.title.trim();
  return { company, roleTitle, complete: company !== "" && roleTitle !== "" };
}

/**
 * Whether to offer the paste box.
 *
 * Every outcome that leaves the row without the posting's words qualifies —
 * including a read that succeeded and found nothing usable, which is what a
 * page behind a login looks like.
 */
export function needsPaste(read: { kind: string; empty?: boolean }): boolean {
  if (read.kind === "read") return read.empty === true;
  return true;
}
