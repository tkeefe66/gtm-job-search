import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_PAGE_MARGIN,
  TOKEN_CSS_FILES,
  buildDownloadHtml,
  downloadFilename,
} from "./resume-download";

describe("the inlined CSS list cannot drift from styles.css", () => {
  // styles.css is nothing but @import lines. Hardcoding the list here is a
  // second place that must not drift — the same hazard the retention
  // predicates close, applied to the stylesheet.
  test("TOKEN_CSS_FILES equals styles.css's @import order", () => {
    const css = readFileSync(
      join(process.cwd(), "public", "resume-design", "styles.css"),
      "utf8"
    );
    const imports: string[] = [];
    const re = /@import\s+"tokens\/([a-z-]+\.css)"/g;
    let m = re.exec(css);
    while (m !== null) {
      imports.push(m[1]);
      m = re.exec(css);
    }
    expect(imports.length).toBeGreaterThan(0);
    expect(TOKEN_CSS_FILES).toEqual(imports);
  });
});

describe("buildDownloadHtml", () => {
  const args = {
    markup: '<div class="rsm"><p>hello</p></div>',
    css: ".rsm{color:red}",
    docPageJs: "/* doc-page */",
    title: "Résumé — VP Sales at Acme",
  };

  test("is a complete standalone document", () => {
    const out = buildDownloadHtml(args);
    expect(out).toContain("<!doctype html>");
    expect(out).toContain("</html>");
  });

  test("inlines the CSS and the markup", () => {
    const out = buildDownloadHtml(args);
    expect(out).toContain(".rsm{color:red}");
    expect(out).toContain("<p>hello</p>");
  });

  test("inlines doc-page.js, which owns ALL print geometry", () => {
    // doc-page.js:30 says never write your own @page rule, and there are no
    // @page rules in the token CSS at all. A JS-free file has no geometry.
    const out = buildDownloadHtml(args);
    expect(out).toContain("/* doc-page */");
    expect(out).toContain("<doc-page");
  });

  test("escapes the title so a company name cannot inject markup", () => {
    const out = buildDownloadHtml({ ...args, title: 'a<script>alert(1)</script>' });
    expect(out).not.toContain("<script>alert(1)</script>");
  });

  // A downloaded file is a fourth surface (chat -> draft -> saved screen ->
  // download) that must not silently revert a saved résumé's own margin back
  // to the default — the identical symptom Task 14 fixed on the other three.
  test("carries a non-default pageMargin into the exported <doc-page>", () => {
    const out = buildDownloadHtml({ ...args, pageMargin: "0.5in" });
    expect(out).toContain('<doc-page margin="0.5in">');
  });

  test("a null pageMargin (every row predating the column) falls back to the default", () => {
    const out = buildDownloadHtml({ ...args, pageMargin: null });
    expect(out).toContain('<doc-page margin="' + DEFAULT_PAGE_MARGIN + '">');
  });

  test("an omitted pageMargin also falls back to the default", () => {
    const out = buildDownloadHtml(args);
    expect(out).toContain('<doc-page margin="' + DEFAULT_PAGE_MARGIN + '">');
  });
});

describe("downloadFilename", () => {
  test("is readable and filesystem-safe", () => {
    expect(downloadFilename("VP Sales", "Acme Corp", "2026-09-07T12:00:00.000Z")).toBe(
      "resume-acme-corp-vp-sales-2026-09-07.html"
    );
  });

  test("collapses punctuation rather than emitting it", () => {
    expect(downloadFilename("Head of GTM/RevOps", "N/A Inc.", "2026-09-07T12:00:00.000Z")).toBe(
      "resume-n-a-inc-head-of-gtm-revops-2026-09-07.html"
    );
  });
});
