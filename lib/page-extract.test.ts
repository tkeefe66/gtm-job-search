import { describe, expect, test } from "vitest";
import {
  hiringOrganizationFrom,
  jobPostingFrom,
  isJsShell,
  MAX_PAGE_CHARS,
  readPostingPage,
  stripHtml,
} from "./page-extract";

const REAL_PAGE = `
<html><head><style>.a{color:red}</style><script>var x=1;</script></head>
<body>
  <nav><a href="/about">About us</a></nav>
  <h1>Open roles at Example</h1>
  <p>We are hiring across go-to-market and engineering. ${"Filler sentence about the team and mission. ".repeat(20)}</p>
  <ul>
    <li><a href="/careers/head-of-revops">Head of Revenue Operations</a></li>
    <li><a href="/careers/gtm-engineer">GTM Engineer</a></li>
    <li><a href="/careers/marketing-ops">Marketing Operations Manager</a></li>
    <li><a href="/careers/backend-eng">Backend Engineer</a></li>
  </ul>
  <footer><a href="/privacy">Privacy</a></footer>
</body></html>`;

const ATS_SHELL = `
<html><head><script src="https://boards.greenhouse.io/embed/job_board/js?for=example"></script></head>
<body><div id="grnhse_app"></div></body></html>`;

describe("stripHtml", () => {
  test("removes script and style content from the text", () => {
    const page = stripHtml(REAL_PAGE);
    expect(page.text).not.toContain("var x=1");
    expect(page.text).not.toContain("color:red");
  });

  test("keeps visible body copy", () => {
    expect(stripHtml(REAL_PAGE).text).toContain("Open roles at Example");
  });

  test("drops nav and footer content", () => {
    const page = stripHtml(REAL_PAGE);
    expect(page.text).not.toContain("Privacy");
    expect(page.text).not.toContain("About us");
  });

  test("collects anchors with href and text", () => {
    const page = stripHtml(REAL_PAGE);
    const hrefs = page.links.map((l) => l.href);
    expect(hrefs).toContain("/careers/head-of-revops");
    const revops = page.links.find((l) => l.href === "/careers/head-of-revops");
    expect(revops?.text).toBe("Head of Revenue Operations");
  });

  test("collapses runs of whitespace", () => {
    expect(stripHtml("<p>a   \n\n  b</p>").text).toBe("a b");
  });

  test("decodes the common named entities", () => {
    expect(stripHtml("<p>R&amp;D &nbsp;team</p>").text).toBe("R&D team");
  });

  test("truncates very long pages", () => {
    const huge = `<p>${"word ".repeat(50_000)}</p>`;
    expect(stripHtml(huge).text.length).toBeLessThanOrEqual(MAX_PAGE_CHARS);
  });
});

describe("isJsShell", () => {
  test("an empty ATS embed is a shell", () => {
    expect(isJsShell(stripHtml(ATS_SHELL))).toBe(true);
  });

  test("a populated careers page is not a shell", () => {
    expect(isJsShell(stripHtml(REAL_PAGE))).toBe(false);
  });

  test("long prose with no job links is a shell", () => {
    const page = stripHtml(`<p>${"About our culture and values. ".repeat(40)}</p>`);
    expect(isJsShell(page)).toBe(true);
  });

  test("job links alone are not enough without content", () => {
    const page = stripHtml(
      `<a href="/jobs/1">A</a><a href="/jobs/2">B</a><a href="/jobs/3">C</a>`
    );
    expect(isJsShell(page)).toBe(true);
  });
});

describe("isJsShell threshold boundaries", () => {
  // Pins MIN_JOB_LINKS = 3. Both fixtures carry the same abundant prose
  // (well over 500 chars), so the content-length condition is comfortably
  // satisfied and never decides the outcome — only the link count varies.
  const abundantProse = "Filler sentence about the team and mission. ".repeat(30);

  function linksFixture(count: number): string {
    const links = Array.from(
      { length: count },
      (_, i) => `<a href="/careers/role-${i}">Role ${i}</a>`
    ).join("");
    return `<html><body><p>${abundantProse}</p>${links}</body></html>`;
  }

  test("2 job-like links, below MIN_JOB_LINKS, is a shell", () => {
    const page = stripHtml(linksFixture(2));
    expect(page.text.length).toBeGreaterThan(500);
    expect(page.links.length).toBe(2);
    expect(isJsShell(page)).toBe(true);
  });

  test("3 job-like links, at MIN_JOB_LINKS, is not a shell", () => {
    const page = stripHtml(linksFixture(3));
    expect(page.text.length).toBeGreaterThan(500);
    expect(page.links.length).toBe(3);
    expect(isJsShell(page)).toBe(false);
  });

  // Pins MIN_CONTENT_CHARS = 500. Both fixtures carry 3 job-like links, so
  // the link-count condition is comfortably satisfied and never decides the
  // outcome — only the collapsed text length varies. The filler is built
  // from a non-whitespace, non-entity character, so each character added
  // contributes exactly one character to the final collapsed text (collapse()
  // only touches whitespace runs) — the mapping from fillerLen to
  // text.length is computed here, not hand-counted, and the exact resulting
  // length is asserted below so a future reader can see the fixture really
  // sits where its name claims.
  function contentFixtureHtml(fillerLen: number): string {
    const filler = "x".repeat(fillerLen);
    return `<html><body><p>${filler}</p><a href="/careers/a">Role A</a><a href="/careers/b">Role B</a><a href="/careers/c">Role C</a></body></html>`;
  }

  const fixedOverhead = stripHtml(contentFixtureHtml(1)).text.length - 1;

  test("text length just under MIN_CONTENT_CHARS is a shell", () => {
    const target = 499;
    const page = stripHtml(contentFixtureHtml(target - fixedOverhead));
    expect(page.text.length).toBe(target);
    expect(page.links.length).toBe(3);
    expect(isJsShell(page)).toBe(true);
  });

  test("text length at MIN_CONTENT_CHARS is not a shell", () => {
    const target = 500;
    const page = stripHtml(contentFixtureHtml(target - fixedOverhead));
    expect(page.text.length).toBe(target);
    expect(page.links.length).toBe(3);
    expect(isJsShell(page)).toBe(false);
  });
});

// A POSTING page is not a listing page, and isJsShell cannot judge one:
// its second clause requires three job links, which a single posting has no
// reason to carry. Running the backfill through classifyFetchOutcome (as the
// posting-detail spec first said to) classified every real posting as a shell
// and skipped the entire table.
describe("readPostingPage judges a single posting, not a listing", () => {
  const long = "The role requires five years of experience. ".repeat(20);

  test("a posting with plenty of text and no job links is readable", () => {
    const res = readPostingPage(`<html><body><p>${long}</p></body></html>`);

    expect(res.kind).toBe("content");
  });

  test("a JS shell with nothing rendered is still a shell", () => {
    expect(readPostingPage("<html><body><div id='root'></div></body></html>").kind).toBe("shell");
  });

  test("what it read is what the prompt gets", () => {
    const res = readPostingPage(`<html><body><p>${long}</p></body></html>`);

    expect(res.kind === "content" && res.page.text).toContain("five years of experience");
  });
});

// Job pages publish schema.org JobPosting for Google Jobs, and its
// hiringOrganization is the employer's OWN spelling of its name — the only
// employer-declared name available on a page we merely fetched.
describe("hiringOrganizationFrom reads the posting's own structured data", () => {
  const ld = (obj: unknown) =>
    `<html><head><script type="application/ld+json">${JSON.stringify(obj)}</script></head></html>`;

  test("a plain JobPosting", () => {
    const html = ld({
      "@type": "JobPosting",
      title: "RevOps Manager",
      hiringOrganization: { "@type": "Organization", name: "Baseten" },
    });

    expect(hiringOrganizationFrom(html)).toBe("Baseten");
  });

  test("an organization given as a bare string", () => {
    expect(hiringOrganizationFrom(ld({ "@type": "JobPosting", hiringOrganization: "Baseten" }))).toBe(
      "Baseten"
    );
  });

  test("a @graph, which is how most CMS pages ship it", () => {
    const html = ld({
      "@graph": [
        { "@type": "WebPage", name: "Careers" },
        { "@type": "JobPosting", hiringOrganization: { name: "Baseten" } },
      ],
    });

    expect(hiringOrganizationFrom(html)).toBe("Baseten");
  });

  // The Organization on a page is very often the JOB BOARD, not the employer:
  // a reseller marks itself up as the site's publisher. Only a JobPosting's
  // hiringOrganization counts.
  test("a site-level Organization is not the employer", () => {
    expect(hiringOrganizationFrom(ld({ "@type": "Organization", name: "BuiltIn" }))).toBeNull();
  });

  test("malformed JSON in one block does not lose a later good one", () => {
    const html =
      `<script type="application/ld+json">{ not json }</script>` +
      ld({ "@type": "JobPosting", hiringOrganization: { name: "Baseten" } });

    expect(hiringOrganizationFrom(html)).toBe("Baseten");
  });

  test("a page with no structured data says nothing", () => {
    expect(hiringOrganizationFrom("<html><body>Apply now</body></html>")).toBeNull();
  });
});

// Manual URL intake needs an IDENTITY for a role nobody has typed: which role,
// at which company. schema.org publishes both.
describe("jobPostingFrom reads the posting's identity", () => {
  const ld = (obj: unknown) =>
    `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;

  test("title and employer together", () => {
    const html = ld({
      "@type": "JobPosting",
      title: "Director, Revenue Operations",
      hiringOrganization: { name: "Baseten" },
    });

    expect(jobPostingFrom(html)).toEqual({
      title: "Director, Revenue Operations",
      company: "Baseten",
    });
  });

  test("a posting with one and not the other still yields what it has", () => {
    expect(jobPostingFrom(ld({ "@type": "JobPosting", title: "RevOps Lead" }))).toEqual({
      title: "RevOps Lead",
      company: null,
    });
  });

  test("no structured data yields neither", () => {
    expect(jobPostingFrom("<p>Apply now</p>")).toEqual({ title: null, company: null });
  });
})
