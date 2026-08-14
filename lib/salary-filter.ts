import { baseMaxFor, parseSalaryRange } from "@/lib/salary";

export type SalaryBucket = "meets" | "below" | "ote" | "no-range" | "unreadable";

/** The two /roles compensation toggles. Independent booleans, both off by default. */
export interface CompFilters {
  /** Hide roles whose stated base tops out under the floor. */
  meetsOnly: boolean;
  /** Hide roles that published no readable range. */
  hideNoRange: boolean;
}

/**
 * Which compensation bucket a job falls into for display filtering.
 *
 * "no-range" and "unreadable" are separate on purpose: the first is the
 * employer publishing nothing, the second is a parser gap. Collapsing them
 * would hide the parser gap forever behind a UI that looks correct.
 * (parseSalaryRange already logs the unreadable case; a second warn here would
 * fire again for every row on every keystroke in the search box.)
 *
 * "ote" is its own bucket, never "below". OTE bundles commission, so it is not
 * a base figure and must not be compared to a base floor — and bucketing it
 * with below-floor roles IS comparing it, because the "Meets minimum" toggle
 * hides "below". `$300,000 - $340,000 OTE` is a role whose base almost
 * certainly clears any realistic floor; it disappearing next to genuinely
 * underpaying roles is the bug this bucket exists to prevent.
 */
export function salaryBucketFor(
  job: { salary_range: string | null },
  floor: number | null
): SalaryBucket {
  const parsed = parseSalaryRange(job.salary_range);
  if (parsed.kind === "absent") return "no-range";
  if (parsed.kind === "unparseable") return "unreadable";
  const base = baseMaxFor(parsed);
  // Known figure, but not a base one — see the "ote" note above.
  if (base === null) return "ote";
  if (floor === null) return "meets";
  // `>=`: a band whose top IS the stated minimum meets the minimum.
  return base >= floor ? "meets" : "below";
}

/**
 * Whether a job survives the two compensation toggles.
 *
 * The bucket-to-toggle mapping lives here rather than in the component so it
 * can be pinned by tests — React components are not unit-tested in this repo,
 * and this mapping is exactly where the OTE regression happened.
 *
 * Note what each toggle does NOT hide. "Meets minimum" hides only "below":
 * "pays too little" and "didn't tell me" are different facts with different
 * toggles, and "ote" is neither. "No range listed" hides the two silent
 * buckets and leaves every priced role, OTE included, on screen.
 */
export function passesCompFilters(
  job: { salary_range: string | null },
  floor: number | null,
  filters: CompFilters
): boolean {
  return bucketPasses(salaryBucketFor(job, floor), filters);
}

/**
 * The same decision, for a caller that has already computed the bucket.
 *
 * Exists so the table can bucket each job ONCE per render and reuse it for
 * both the filter and the row tag. Bucketing twice re-parses every salary
 * string twice, and — because parseSalaryRange logs the unreadable case — logs
 * each unreadable row twice on every keystroke in the search box.
 */
export function bucketPasses(bucket: SalaryBucket, filters: CompFilters): boolean {
  if (filters.meetsOnly && bucket === "below") return false;
  if (filters.hideNoRange && (bucket === "no-range" || bucket === "unreadable")) {
    return false;
  }
  return true;
}

/**
 * Row tags for the buckets that carry no comparable base figure.
 *
 * Three distinct labels, not two: "Range unreadable" is the only place a
 * parser gap becomes visible to a human, and giving it the same words as
 * "No range listed" would bury it again.
 */
export const COMP_BUCKET_TAGS: Partial<Record<SalaryBucket, string>> = {
  "no-range": "No range listed",
  unreadable: "Range unreadable",
  ote: "OTE only",
};
