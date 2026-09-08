import { describe, expect, test } from "vitest";

import { notAPosting } from "./not-a-posting";

// Found in production 2026-09-07, 15 of them: rows whose "posting" is a job
// board's SEARCH page, and companies that are a description rather than an
// employer. They can never be read, applied to, or verified — there is no
// posting behind them — and they had been scored 2-4 and were sitting in the
// open pipeline looking like work.
describe("a link that is a search, not a posting", () => {
  test("Indeed query pages", () => {
    expect(notAPosting("https://www.indeed.com/q-new-product-introduction-npi-manager-jobs.html", "Acme")).toBe(
      "search-page"
    );
  });

  test("ZipRecruiter category pages", () => {
    expect(notAPosting("https://www.ziprecruiter.com/Jobs/Industrial-Coatings-Manager", "Acme")).toBe(
      "search-page"
    );
    expect(
      notAPosting("https://www.ziprecruiter.com/Jobs/Director-Of-Product-Management/-in-Boston,MA", "Acme")
    ).toBe("search-page");
  });

  test("Glassdoor search pages", () => {
    expect(
      notAPosting("https://www.glassdoor.com/Job/chicago-commercialization-manager-jobs-SRCH_IL.0,7.htm", "Acme")
    ).toBe("search-page");
  });

  // The other direction matters more than the first: these are real postings on
  // the same hosts, and closing them would delete real work.
  test("a real posting on the same host is untouched", () => {
    for (const url of [
      "https://www.indeed.com/viewjob?jk=abc123",
      "https://www.ziprecruiter.com/c/AdAction/Job/Director,-Revenue-Operations/-in-Denver,CO?jid=f0c",
      "https://www.glassdoor.com/job-listing/senior-manager-acme-JV_IC1128808_KO0,14.htm",
      "https://www.linkedin.com/jobs/view/product-manager-at-brenntag-3726153889",
      "https://job-boards.greenhouse.io/anthropic/jobs/4461450008",
      "https://www.databricks.com/company/careers/exec-sales/leader-of-gtm-8486165002",
    ]) {
      expect(notAPosting(url, "Acme")).toBeNull();
    }
  });
});

describe("a company that is a description, not an employer", () => {
  test("placeholder names the extraction invented", () => {
    for (const company of [
      "Confidential (Chicago-area CPG/Packaging Company)",
      "Confidential (via CSG Talent)",
      "Confidential (via ZipRecruiter / Direct Hire)",
      "confidential",
      "Undisclosed",
      "Stealth Startup",
    ]) {
      expect(notAPosting("https://job-boards.greenhouse.io/x/jobs/1", company)).toBe("no-employer");
    }
  });

  // A real company whose name merely contains one of those words must survive:
  // closing "Confidential Computing Inc" would delete a real employer.
  test("a real employer whose name contains the word is untouched", () => {
    expect(notAPosting("https://job-boards.greenhouse.io/x/jobs/1", "Confidential Computing Inc")).toBeNull();
    expect(notAPosting("https://job-boards.greenhouse.io/x/jobs/1", "Stealth Health")).toBeNull();
  });
});

test("a row with no link at all is not judged here", () => {
  expect(notAPosting(null, "Acme")).toBeNull();
});
