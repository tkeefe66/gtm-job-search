import { describe, expect, test } from "vitest";
import { classifyJobLink, companySlugs, hostOf, parseBoardLink } from "./job-link";

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

  // Found by sweeping every distinct job_url host in production against these
  // two lists on 2026-09-07. All three were classifying as `other` — which
  // this file defines as the EMPLOYER speaking for itself — so link health
  // believed jobleads.com was DataRobot's own careers site and never looked
  // for a better link. That row answers 403 to every fetch, so nothing else
  // in the pass had anything to say about it either, and it sat as New.
  test("the resellers the host sweep found", () => {
    expect(
      classifyJobLink("https://www.jobleads.com/us/job/vp-revenue-operations--boston--e14d3")
    ).toBe("aggregator");
    expect(classifyJobLink("https://www.themuse.com/jobs/acme/vp-revenue-operations")).toBe(
      "aggregator"
    );
    expect(classifyJobLink("https://remotive.com/remote-jobs/sales/vp-revops-1234567")).toBe(
      "aggregator"
    );
  });

  test("a company's own domain is 'other', not a problem to fix", () => {
    // The employer speaking for itself, just not through a vendor we know.
    expect(classifyJobLink("https://elevenlabs.io/careers/123")).toBe("other");
    expect(classifyJobLink("https://www.workato.com/careers/abc")).toBe("other");
    // The same sweep's negative half. These read like job boards and are not:
    // a careers subdomain is still the employer, and adding one here would
    // send the pass hunting for a "better" link than the real one.
    expect(classifyJobLink("https://corningjobs.corning.com/job/1")).toBe("other");
    expect(classifyJobLink("https://jobs.appliedmaterials.com/job/2")).toBe("other");
    expect(classifyJobLink("https://careers.te.com/job/3")).toBe("other");
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

describe("parseBoardLink", () => {
  // Mutation this catches: requiring only the host to match, so a bare board
  // page parses. There is no posting id on `jobs.ashbyhq.com/baseten`, so a
  // caller would then ask "is this posting on the board" about a URL that names
  // no posting — and every such row would relink to some arbitrary title match.
  test("each vendor's deep link parses to its vendor and slug", () => {
    expect(
      parseBoardLink("https://jobs.ashbyhq.com/baseten/5cd2f489-b9ee-428b-b252-94e83d55f107")
    ).toEqual({ vendor: "ashby", slug: "baseten", id: "5cd2f489-b9ee-428b-b252-94e83d55f107" });
    expect(parseBoardLink("https://job-boards.greenhouse.io/clay/jobs/4012")).toEqual({
      vendor: "greenhouse",
      slug: "clay",
      id: "4012",
    });
    expect(parseBoardLink("https://boards.greenhouse.io/clay/jobs/4012")).toEqual({
      vendor: "greenhouse",
      slug: "clay",
      id: "4012",
    });
    expect(parseBoardLink("https://boards.eu.greenhouse.io/nebius/jobs/1")).toEqual({
      vendor: "greenhouse",
      slug: "nebius",
      id: "1",
    });
    expect(parseBoardLink("https://jobs.lever.co/atlan/8f0a-1")).toEqual({
      vendor: "lever",
      slug: "atlan",
      id: "8f0a-1",
    });
    expect(parseBoardLink("https://apply.workable.com/asseti/j/ABC123/")).toEqual({
      vendor: "workable",
      slug: "asseti",
      id: "ABC123",
    });
    expect(parseBoardLink("https://asseti.breezy.hr/p/9f2c1")).toEqual({
      vendor: "breezy",
      slug: "asseti",
      id: "9f2c1",
    });
  });

  // Mutation this catches: keeping the apply step in the id. Ashby and Lever
  // both hang one off a posting URL, so `.../<id>/application` and `.../<id>`
  // are the same req — and an id that disagrees makes `verifyPostingLink` call
  // a HEALTHY stored link missing.
  test("an apply step is not part of the posting's identity", () => {
    expect(parseBoardLink("https://jobs.ashbyhq.com/baseten/abc/application")).toEqual({
      vendor: "ashby",
      slug: "baseten",
      id: "abc",
    });
    expect(parseBoardLink("https://jobs.lever.co/atlan/8f0a-1/apply")).toEqual({
      vendor: "lever",
      slug: "atlan",
      id: "8f0a-1",
    });
  });

  // Mutation this catches: lowercasing the id for tolerance, the way pathOf
  // does. Workable and Breezy ids are case-sensitive base62, so that merges
  // two distinct postings.
  test("the id keeps its case", () => {
    expect(parseBoardLink("https://apply.workable.com/asseti/j/aB3xZ/")?.id).toBe("aB3xZ");
    expect(parseBoardLink("https://asseti.breezy.hr/p/Qq7Zz")?.id).toBe("Qq7Zz");
  });

  // Workable's board API returns this shape in `shortlink`, and it is the only
  // posting reference that names no company. Comparable, but never a board to
  // look anything up on — verifyPostingLink refuses it as a starting point.
  test("a Workable shortlink parses with an empty slug", () => {
    expect(parseBoardLink("https://apply.workable.com/j/ABC123")).toEqual({
      vendor: "workable",
      slug: "",
      id: "ABC123",
    });
  });

  test("a bare board page is null — there is no posting to verify", () => {
    expect(parseBoardLink("https://jobs.ashbyhq.com/baseten")).toBeNull();
    expect(parseBoardLink("https://jobs.ashbyhq.com/baseten/")).toBeNull();
    expect(parseBoardLink("https://job-boards.greenhouse.io/clay")).toBeNull();
    expect(parseBoardLink("https://jobs.lever.co/atlan")).toBeNull();
    expect(parseBoardLink("https://apply.workable.com/asseti/")).toBeNull();
    expect(parseBoardLink("https://asseti.breezy.hr/")).toBeNull();
  });

  // Mutation this catches: matching greenhouse/workable on the slug segment
  // alone, ignoring the "jobs"/"j" segment. `/clay/foo/1` is not a posting URL
  // and the id read out of it would be meaningless.
  test("a path that is not the vendor's posting shape is null", () => {
    expect(parseBoardLink("https://job-boards.greenhouse.io/clay/embed/1")).toBeNull();
    expect(parseBoardLink("https://apply.workable.com/asseti/x/ABC123/")).toBeNull();
    expect(parseBoardLink("https://asseti.breezy.hr/x/9f2c1")).toBeNull();
  });

  // Mutation this catches: widening the vendor lists to every ATS host. These
  // five are the ONLY ones with a control-tested honest board API; the rest
  // must behave exactly as they did before this function existed.
  test("an ATS with no honest board API is null", () => {
    expect(parseBoardLink("https://acme.wd1.myworkdayjobs.com/en-US/careers/job/123")).toBeNull();
    expect(parseBoardLink("https://careers-acme.icims.com/jobs/4567/gtm-engineer/job")).toBeNull();
    expect(parseBoardLink("https://jobs.jobvite.com/acme/job/oX7yzf")).toBeNull();
    expect(parseBoardLink("https://jobs.smartrecruiters.com/Acme/74400001")).toBeNull();
  });

  test("aggregators, company domains and garbage are null", () => {
    expect(parseBoardLink("https://www.builtin.com/job/gtm/12345")).toBeNull();
    expect(parseBoardLink("https://www.ziprecruiter.com/c/Halcyon/Job/VP")).toBeNull();
    expect(parseBoardLink("https://elevenlabs.io/careers/123")).toBeNull();
    expect(parseBoardLink(null)).toBeNull();
    expect(parseBoardLink("")).toBeNull();
    expect(parseBoardLink("not a url")).toBeNull();
    expect(parseBoardLink("javascript:alert(1)")).toBeNull();
  });

  // Mutation this catches: matching lever on the bare "lever.co" suffix. The
  // board API itself lives at api.lever.co, and a lookalike domain is not Lever.
  test("only the vendors' real posting hosts match", () => {
    expect(parseBoardLink("https://api.lever.co/v0/postings/atlan/1")).toBeNull();
    expect(parseBoardLink("https://notlever.co/atlan/1")).toBeNull();
    // These two are the dot-boundary check specifically, and the line above is
    // NOT a substitute: notlever.co/... is already null for lacking the "jobs."
    // prefix, so it passes under a bare `endsWith("lever.co")` too. A stranger's
    // host that DOES carry the prefix is what separates the two, and accepting
    // it hands back a slug we would then fetch from Lever's real API — a slug
    // collision with a matching title relinks the user to an unrelated employer.
    expect(parseBoardLink("https://jobs.notlever.co/acme/123")).toBeNull();
    expect(parseBoardLink("https://jobs.evillever.co/acme/123")).toBeNull();
    expect(parseBoardLink("https://acme.notbreezy.hr/p/1")).toBeNull();
    expect(parseBoardLink("https://boards.notgreenhouse.io/clay/jobs/1")).toBeNull();
    expect(parseBoardLink("https://fakegreenhouse.io/clay/jobs/1")).toBeNull();
    expect(parseBoardLink("https://api.ashbyhq.com/posting-api/job-board/baseten")).toBeNull();
  });

  // Mutation this catches: reading a nested subdomain as a Breezy slug.
  // "careers.acme.breezy.hr" is not a board at slug "careers.acme".
  test("a nested breezy subdomain is not a slug", () => {
    expect(parseBoardLink("https://careers.acme.breezy.hr/p/1")).toBeNull();
  });
});
