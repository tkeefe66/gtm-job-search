// What a followed redirect says about the posting we asked for.
//
// A closed req is often not 404'd. It is 30x'd to the careers listing it came
// from, and that listing answers 200 — so `checkJobUrl`, which set
// `redirect: "follow"` and then read only `res.status`, called the link live.
// Measured 2026-09-07: samsara.com/company/careers/roles/7974118 redirects to
// /company/careers/roles, while a live sibling id redirects nowhere.
//
// Pure and network-free on purpose: the rule is a URL comparison, so it is
// testable against the exact strings production returned rather than against a
// mocked fetch.

export type RedirectVerdict =
  /** The landing page still names the posting we asked for — or nothing moved. */
  | "same"
  /** The posting identifier is gone and the landing page names no posting at all. */
  | "landed-on-listing"
  /** The identifier changed but the landing page still names A posting. */
  | "moved";

/**
 * A path segment names a posting when it carries a digit.
 *
 * Deliberately narrow, and asymmetric in its consequences: this predicate
 * decides both whether the REQUESTED link had an identifier to lose and
 * whether the LANDING page still has one. A segment wrongly called an
 * identifier on the landing side only produces "moved", which closes nothing.
 * A purely alphabetic posting slug — /careers/director-gtm-business-operations
 * — is therefore invisible to this rule rather than at risk from it, which is
 * the trade the stakes require: a "landed-on-listing" closes the role AND
 * stamps never_live at ingest, which hides the row.
 */
function namesAPosting(segment: string): boolean {
  return /\d/.test(segment);
}

function segmentsOf(url: URL): string[] {
  return url.pathname.split("/").filter((s) => s.length > 0);
}

/**
 * Compares where we asked with where we landed.
 *
 * Not "did we land on an ancestor of where we asked": the dead Greenhouse link
 * for the same company hopped to the employer's own domain, and an ancestor
 * test cannot see across hosts. The question is whether the posting identifier
 * survived the trip.
 *
 * Anything unparseable answers "same", so a malformed stored URL can never
 * close a role.
 */
export function redirectVerdict(requested: string, final: string): RedirectVerdict {
  let from: URL;
  let to: URL;
  try {
    from = new URL(requested);
    to = new URL(final);
  } catch {
    return "same";
  }

  const segments = segmentsOf(from);
  const id = segments[segments.length - 1];
  if (id === undefined || !namesAPosting(id)) return "same";

  // Substring, not segment equality: a redirect that appends a slug to the id
  // (/careers/4512339 -> /en-us/careers/4512339-staff-engineer) is the same
  // posting, and equality would read it as a closure.
  if (to.pathname.includes(id)) return "same";

  return segmentsOf(to).some(namesAPosting) ? "moved" : "landed-on-listing";
}
