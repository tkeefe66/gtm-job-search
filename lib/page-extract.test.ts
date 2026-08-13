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
