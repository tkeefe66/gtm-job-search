import { describe, expect, test } from "vitest";
import { isJsShell, MAX_PAGE_CHARS, stripHtml } from "./page-extract";

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
