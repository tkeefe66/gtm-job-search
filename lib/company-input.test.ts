import { describe, expect, it } from "vitest";
import { readCompanyInput } from "./company-input";

describe("readCompanyInput", () => {
  it("reports an empty box as empty", () => {
    expect(readCompanyInput("   ").kind).toBe("empty");
  });

  it("takes a plain name as a name", () => {
    expect(readCompanyInput("  Cursor ")).toEqual({ kind: "name", name: "Cursor" });
  });

  // The boundary that matters, and the reason detection is not "contains a dot":
  // Booking.com and Salesforce.com are company NAMES people type on purpose. A
  // bare dotted token is a name; it takes a scheme, a path, or a www. to be a URL.
  it("takes a bare dotted company name as a name, not a URL", () => {
    expect(readCompanyInput("Booking.com")).toEqual({
      kind: "name",
      name: "Booking.com",
    });
  });

  it("takes a scheme as proof of a URL", () => {
    const got = readCompanyInput("https://cursor.com");
    expect(got.kind).toBe("url");
  });

  it("takes a path after a dotted host as proof of a URL, with no scheme", () => {
    const got = readCompanyInput("cursor.com/careers");
    expect(got).toMatchObject({ kind: "url", suggestion: "Cursor" });
  });

  it("takes a www. prefix as proof of a URL", () => {
    expect(readCompanyInput("www.cursor.com").kind).toBe("url");
  });

  it("suggests the employer, not the domain suffix", () => {
    expect(readCompanyInput("https://cursor.com/careers")).toEqual({
      kind: "url",
      url: "https://cursor.com/careers",
      suggestion: "Cursor",
    });
  });

  it("drops a careers subdomain rather than suggesting it", () => {
    // careers.rtx.com is RTX, not Careers.
    expect(readCompanyInput("https://careers.rtx.com").suggestion).toBe("Rtx");
  });

  it("drops www and a deep path", () => {
    expect(
      readCompanyInput("https://www.nvidia.com/en-us/about-nvidia/careers/")
        .suggestion
    ).toBe("Nvidia");
  });

  // The case a host-only rule gets wrong, and the reason there is a vendor list:
  // every company on Greenhouse shares Greenhouse's host, so the host names the
  // ATS and the first path segment names the employer.
  it("reads the employer out of the path on an ATS board, not the vendor", () => {
    expect(readCompanyInput("https://job-boards.greenhouse.io/cursor").suggestion).toBe(
      "Cursor"
    );
    expect(
      readCompanyInput("https://boards.greenhouse.io/cursor/jobs/4012").suggestion
    ).toBe("Cursor");
    expect(readCompanyInput("https://jobs.lever.co/ramp").suggestion).toBe("Ramp");
    expect(readCompanyInput("https://jobs.ashbyhq.com/openai").suggestion).toBe("Openai");
  });

  it("reads a Workday tenant out of the host, where the employer is a subdomain", () => {
    expect(
      readCompanyInput("https://rtx.wd5.myworkdayjobs.com/en-US/Careers").suggestion
    ).toBe("Rtx");
  });

  it("keeps a hyphenated employer readable", () => {
    expect(readCompanyInput("https://well-said.com/careers").suggestion).toBe(
      "Well-Said"
    );
  });

  it("suggests nothing rather than guessing when the URL yields no employer", () => {
    // An ATS host with no path segment names no company. Empty means the confirm
    // step asks the user to type one, which is the honest outcome — a blank
    // suggestion is recoverable, a wrong join key is not.
    expect(readCompanyInput("https://boards.greenhouse.io/").suggestion).toBe("");
  });

  it("returns the url it parsed, so the caller can store it as the careers page", () => {
    // Without a scheme on the way in, the stored URL still has one: setCareersUrl
    // requires http(s)://, so passing the raw input through would fail its check.
    expect(readCompanyInput("cursor.com/careers")).toMatchObject({
      url: "https://cursor.com/careers",
    });
  });
});
