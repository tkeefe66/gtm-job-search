import { describe, expect, test } from "vitest";
import { untrackedCompanyNames, untrackedFromWatched } from "./untracked-companies";
import type { RoleMatch } from "./types";

function role(company: string): RoleMatch {
  return {
    company,
    role_title: "Head of RevOps",
    job_url: "",
    location: "",
    seniority: "",
    salary_range: "",
    description_summary: "",
    fit_signal: "",
    ic_flag: false,
  };
}

describe("untrackedCompanyNames", () => {
  test("excludes companies already on the watchlist", () => {
    const out = untrackedCompanyNames([role("Clay"), role("Gong")], ["Clay"]);
    expect(out).toEqual(["Gong"]);
  });

  test("matches tracked companies case-insensitively", () => {
    const out = untrackedCompanyNames([role("Clay")], ["clay"]);
    expect(out).toEqual([]);
  });

  test("trims a company name with stray whitespace before returning it", () => {
    // Catches the bug this function was fixed for: comparing on a trimmed
    // key but returning the untrimmed raw string, which then fails
    // groupRolesByCompany's trimmed `untracked.has(company)` lookup.
    const out = untrackedCompanyNames([role("  Clay  ")], []);
    expect(out).toEqual(["Clay"]);
  });

  test("agrees with groupRolesByCompany's trimmed lowercase key for the same input", () => {
    const matches = [role("  Clay  "), role("clay")];
    const out = untrackedCompanyNames(matches, []);
    // Exactly one untracked entry, and it matches what groupRolesByCompany
    // would use as the display key for this same input (first-seen, trimmed).
    expect(out).toEqual(["Clay"]);
  });

  test("dedupes case-insensitively within the match list itself", () => {
    const out = untrackedCompanyNames([role("Clay"), role("CLAY"), role("clay")], []);
    expect(out).toEqual(["Clay"]);
  });

  test("skips matches with an empty or whitespace-only company", () => {
    const out = untrackedCompanyNames([role("  "), role("Clay")], []);
    expect(out).toEqual(["Clay"]);
  });

  test("returns an empty array when every match is already tracked", () => {
    const out = untrackedCompanyNames([role("Clay")], ["Clay"]);
    expect(out).toEqual([]);
    expect(out.length).toBe(0);
  });

  test("matches a tracked company differing only by internal whitespace", () => {
    // Catches a `.toLowerCase()`-only comparison (no whitespace collapse) —
    // the third-normalizer drift task 5's review flagged. A company tracked
    // as "Big  Co" (double space) must exclude a match spelled "Big Co".
    const out = untrackedCompanyNames([role("Big Co")], ["Big  Co"]);
    expect(out).toEqual([]);
  });

  test("accepts already-normalized keys as the tracked list", () => {
    // role-search.ts now passes getWatchedCompanyKeys()'s output here, which
    // is normalizeCompanyName keys rather than raw stored names. The
    // normalizer must be idempotent for that to be equivalent: a key like
    // "big co" has to still exclude a match spelled "  Big  CO ".
    const out = untrackedCompanyNames([role("  Big  CO ")], ["big co"]);
    expect(out).toEqual([]);
    expect(out.length).toBe(0);
  });

  test("matches a tracked company differing by U+00A0 vs a regular space", () => {
    // Built with an explicit \xa0 escape, not a pasted character.
    const nbspTracked = "Big" + "\xa0" + "Co";
    const out = untrackedCompanyNames([role("Big Co")], [nbspTracked]);
    expect(out).toEqual([]);
  });
});

describe("untrackedFromWatched", () => {
  // getWatchedCompanyKeys discarded its query error and returned a bare empty
  // Set, which reads as "nothing is tracked" — indistinguishable from the
  // failure. Every company then rendered with a Track button, and that button
  // WRITES.

  test("a failed lookup offers NOTHING to track, rather than everything", () => {
    // The regression. With the old bare-Set shape this returned both
    // companies, offering a write for each on evidence that did not exist.
    const matches = [role("Acme"), role("Globex")];
    expect(untrackedFromWatched(matches, { keys: [], error: "connection refused" })).toEqual([]);
  });

  test("an EMPTY error message is still a failed lookup", () => {
    // Presence, not truthiness — the whole defect class. `if (watched.error)`
    // sends a connection-level failure straight down the success branch.
    const matches = [role("Acme"), role("Globex")];
    expect(untrackedFromWatched(matches, { keys: [], error: "" })).toEqual([]);
  });

  test("a clean lookup with genuinely nothing tracked DOES offer every company", () => {
    // The other side of the branch, and it is load-bearing: without it,
    // "always return []" passes both tests above. A real empty watchlist must
    // still surface Track buttons — that is the normal first-run state.
    const matches = [role("Acme"), role("Globex")];
    const out = untrackedFromWatched(matches, { keys: [] });
    expect(out).toHaveLength(2);
    expect(out).toEqual(["Acme", "Globex"]);
  });

  test("a clean lookup still excludes what is tracked, case-insensitively", () => {
    const out = untrackedFromWatched([role("Acme"), role("Globex")], { keys: ["ACME"] });
    expect(out).toHaveLength(1);
    expect(out).toEqual(["Globex"]);
  });
});
