import { describe, expect, it } from "vitest";
import { KNOWN_SOURCES, sourceOptions } from "./job-sources";

describe("sourceOptions", () => {
  it("offers only the sources actually present", () => {
    expect(sourceOptions(["Crawl", "Crawl", "Discover"])).toEqual(["Crawl", "Discover"]);
  });

  it("orders known sources by KNOWN_SOURCES, not by row order", () => {
    // Recruiter arrives first in the data and must still sort last.
    expect(sourceOptions(["Recruiter", "Discover", "Crawl"])).toEqual([
      "Crawl",
      "Discover",
      "Recruiter",
    ]);
  });

  it("keeps an unrecognised value rather than dropping it", () => {
    // A new insert path that forgets the known strings must stay filterable —
    // the same rule ProvenanceBadge follows when it renders the value verbatim.
    expect(sourceOptions(["Crawl", "Referral"])).toEqual(["Crawl", "Referral"]);
  });

  it("puts unknown values after known ones, sorted for stability", () => {
    expect(sourceOptions(["zeta", "Crawl", "alpha"])).toEqual(["Crawl", "alpha", "zeta"]);
  });

  it("ignores null and blank sources", () => {
    expect(sourceOptions([null, "", "   ", "Crawl"])).toEqual(["Crawl"]);
  });

  it("returns nothing for an empty table", () => {
    expect(sourceOptions([])).toEqual([]);
  });

  it("lists every known source when all are present", () => {
    expect(sourceOptions([...KNOWN_SOURCES])).toEqual([...KNOWN_SOURCES]);
  });
});
