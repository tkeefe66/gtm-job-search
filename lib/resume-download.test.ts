import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_PAGE_MARGIN,
  TOKEN_CSS_FILES,
  buildDownloadHtml,
  PORTRAIT_PAGE_CSS,
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

describe("the printed page box is pinned to portrait", () => {
  const args = {
    markup: '<div class="rsm"><p>hello</p></div>',
    css: ".rsm{color:red}",
    docPageJs: "/* doc-page */",
    title: "Résumé",
  };

  // Mutation: dropping PORTRAIT_PAGE_CSS from buildDownloadHtml. doc-page.js emits
  // `@page { margin: 0 }` with NO size descriptor for a flowing document — deliberately,
  // so it can be printed on any paper — which leaves the page box to the print dialog's
  // Layout setting. Measured on the deployed app: with Layout on Landscape the usable
  // band is 816px (612pt) instead of 925.44px, so Chrome broke two bullets earlier than
  // rsm-page-guides.js predicted, and the on-screen marker read as wrong for a day.
  // Nothing else in the document sets a `size` descriptor, so this rule is unopposed.
  test("emits a portrait @page size in the standalone export", () => {
    expect(buildDownloadHtml(args)).toContain(PORTRAIT_PAGE_CSS);
    expect(PORTRAIT_PAGE_CSS).toMatch(/@page\s*\{[^}]*size:\s*portrait/);
  });

  // Mutation: setting the margin here too. doc-page.js owns the margin descriptor and
  // resolves it from the <doc-page margin> attribute; a second one racing it per
  // source order would silently override a saved row's own page_margin.
  test("sets only the size descriptor, never the margin", () => {
    expect(PORTRAIT_PAGE_CSS).not.toMatch(/margin/);
  });

  // Mutation: one screen keeping a copy of the literal instead of importing the
  // constant. Four surfaces render a <doc-page> and all four have to agree — the same
  // drift DEFAULT_PAGE_MARGIN exists to prevent, reached through a different attribute.
  test("is imported by every surface that renders a doc-page, never re-typed", () => {
    const dir = process.cwd();
    for (const f of ["components/resume/ResumeDocument.tsx", "components/resume/SavedResumePanel.tsx"]) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src, f + " must import the shared rule").toContain("PORTRAIT_PAGE_CSS");
      expect(src, f + " must not re-type the @page rule").not.toMatch(/@page\s*\{/);
    }
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
