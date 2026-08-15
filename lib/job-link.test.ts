import { describe, expect, test } from "vitest";
import { classifyJobLink, companySlugs, hostOf } from "./job-link";

describe("classifyJobLink", () => {
  test("employer boards on a known ATS are direct", () => {
    expect(classifyJobLink("https://job-boards.greenhouse.io/invoca/jobs/123")).toBe("ats");
    expect(classifyJobLink("https://jobs.ashbyhq.com/hex/abc")).toBe("ats");
    expect(classifyJobLink("https://jobs.lever.co/atlan/xyz")).toBe("ats");
  });

  test("a regional ATS subdomain is still the employer's board", () => {
    // boards.eu.greenhouse.io is a real host in this pipeline; a list of exact
    // hostnames would have missed it.
    expect(classifyJobLink("https://boards.eu.greenhouse.io/nebius/jobs/1")).toBe("ats");
  });

  test("resellers are aggregators", () => {
    expect(classifyJobLink("https://www.ziprecruiter.com/c/Halcyon/Job/VP")).toBe("aggregator");
    expect(classifyJobLink("https://builtin.com/job/gtm/123")).toBe("aggregator");
    expect(classifyJobLink("https://www.builtincolorado.com/job/456")).toBe("aggregator");
  });

  test("a company's own domain is 'other', not a problem to fix", () => {
    // The employer speaking for itself, just not through a vendor we know.
    expect(classifyJobLink("https://elevenlabs.io/careers/123")).toBe("other");
    expect(classifyJobLink("https://www.workato.com/careers/abc")).toBe("other");
  });

  test("remote.com is the employer Remote, not a job aggregator", () => {
    // Listing it as an aggregator would flag that company's own careers page
    // as a middleman link and send us hunting for a 'better' one.
    expect(classifyJobLink("https://remote.com/jobs/gtm-lead")).toBe("other");
  });

  test("a host is matched on a dot boundary, never as a substring", () => {
    // A tracking parameter naming another host must not reclassify the link,
    // and a lookalike domain is a different site.
    expect(classifyJobLink("https://www.ziprecruiter.com/job/1?utm_source=lever.co")).toBe(
      "aggregator"
    );
    expect(classifyJobLink("https://notlever.co/jobs/1")).toBe("other");
    expect(classifyJobLink("https://fakegreenhouse.io/jobs/1")).toBe("other");
  });

  test("no usable URL is null, which is not 'other'", () => {
    expect(classifyJobLink(null)).toBeNull();
    expect(classifyJobLink(undefined)).toBeNull();
    expect(classifyJobLink("")).toBeNull();
    expect(classifyJobLink("not a url")).toBeNull();
    expect(classifyJobLink("javascript:alert(1)")).toBeNull();
  });
});

describe("hostOf", () => {
  test("strips www and lowercases", () => {
    expect(hostOf("https://WWW.ZipRecruiter.com/x")).toBe("ziprecruiter.com");
  });

  test("null for anything unusable", () => {
    expect(hostOf("mailto:a@b.com")).toBeNull();
    expect(hostOf(null)).toBeNull();
  });
});

describe("companySlugs", () => {
  test("offers both the squashed and hyphenated spelling", () => {
    expect(companySlugs("Candid Health")).toEqual(["candidhealth", "candid-health"]);
  });

  test("a one-word name yields exactly one candidate", () => {
    expect(companySlugs("Invoca")).toEqual(["invoca"]);
  });

  test("drops punctuation and legal suffixes", () => {
    expect(companySlugs("Acme, Inc.")).toEqual(["acme"]);
    expect(companySlugs("O'Reilly Media")).toEqual(["oreillymedia", "oreilly-media"]);
  });

  test("a name with nothing usable yields no candidates", () => {
    // Better to try nothing than to probe every vendor for "/".
    expect(companySlugs("   ")).toEqual([]);
    expect(companySlugs("!!!")).toEqual([]);
  });
});
