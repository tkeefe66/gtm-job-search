import { describe, expect, test } from "vitest";
import { buildExtractionPrompt, classifyFetchOutcome, titlesToClose } from "./crawler";
import { stripHtml } from "./page-extract";

// Reused from lib/page-extract.test.ts's own fixtures so the shell/content
// boundary this test relies on stays the one that file already pins.
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

describe("buildExtractionPrompt", () => {
  const page = stripHtml(
    `<p>Open roles</p><a href="/careers/revops">Head of RevOps</a>`
  );

  test("names the company", () => {
    expect(buildExtractionPrompt("Clay", page)).toContain("Clay");
  });

  test("includes the location rule", () => {
    expect(buildExtractionPrompt("Clay", page)).toContain("Denver");
  });

  test("includes the page text and its links", () => {
    const prompt = buildExtractionPrompt("Clay", page);
    expect(prompt).toContain("Open roles");
    expect(prompt).toContain("/careers/revops");
  });

  test("asks for an empty array rather than prose when nothing matches", () => {
    expect(buildExtractionPrompt("Clay", page)).toContain("[]");
  });
});

describe("titlesToClose", () => {
  // runs[0] is the CURRENT run, runs[1] the previous successful one.
  test("closes a title absent from both the current and previous run", () => {
    const runs = [["head of revops"], ["head of revops"]];
    expect(titlesToClose(runs, ["gtm engineer"])).toEqual(["gtm engineer"]);
  });

  test("does not close a title present in the current run", () => {
    const runs = [["gtm engineer"], []];
    expect(titlesToClose(runs, ["gtm engineer"])).toEqual([]);
  });

  test("does not close a role found for the first time today", () => {
    // Regression guard: a role just discovered is in activeTitles but absent
    // from every prior run. Closing it immediately would be wrong.
    const runs = [["gtm engineer"], ["head of revops"]];
    expect(titlesToClose(runs, ["gtm engineer"])).toEqual([]);
  });

  test("does not close after only one successful run", () => {
    expect(titlesToClose([["head of revops"]], ["gtm engineer"])).toEqual([]);
  });

  test("does not close when there are no successful runs at all", () => {
    expect(titlesToClose([], ["gtm engineer"])).toEqual([]);
  });
});

describe("classifyFetchOutcome", () => {
  // This is the pure decision the fetch tier's crawl_method-learning depends
  // on: whether an already-fetched page's HTML genuinely has no jobs (a
  // stable property worth learning) vs. has content worth extracting from.
  // It does not cover "unavailable" (robots block, network error, timeout,
  // non-2xx) — those are decided before any HTML exists and would require
  // mocking `fetch` and `robots.txt` lookups, which this repo has no
  // precedent for; that path is exercised only implicitly via crawlCompany
  // and is not unit tested, same as the rest of the DB/API-dependent code.

  test("an empty ATS embed classifies as a shell", () => {
    expect(classifyFetchOutcome(ATS_SHELL)).toEqual({ kind: "shell" });
  });

  test("a populated careers page classifies as content, carrying the extracted page", () => {
    const result = classifyFetchOutcome(REAL_PAGE);
    expect(result.kind).toBe("content");
    if (result.kind === "content") {
      expect(result.page.text).toContain("Open roles at Example");
      expect(result.page.links.map((l) => l.href)).toContain(
        "/careers/head-of-revops"
      );
    }
  });
});
