import { describe, expect, test } from "vitest";
import { sanitizeResumeHtml, MAX_HTML_BYTES } from "./resume-sanitize";

describe("markup the career record and the renderer actually produce", () => {
  test("keeps <strong>, which reaches the output unescaped from resume.json", () => {
    const out = sanitizeResumeHtml('<div class="rsm"><li>Grew <strong>40%</strong></li></div>');
    expect(out.error).toBeUndefined();
    expect(out.html).toContain("<strong>40%</strong>");
  });

  test("keeps the last section's inline margin-bottom:0", () => {
    const out = sanitizeResumeHtml('<div class="rsm"><section style="margin-bottom:0">x</section></div>');
    expect(out.html).toContain("margin-bottom");
  });

  test("keeps rsm-* classes, which every design selector hangs off", () => {
    const out = sanitizeResumeHtml('<div class="rsm"><p class="rsm-role-org">x</p></div>');
    expect(out.html).toContain('class="rsm-role-org"');
  });
});

describe("markup a browser produces when a human edits", () => {
  test("keeps <br>, which Enter inserts", () => {
    const out = sanitizeResumeHtml('<div class="rsm"><p>one<br />two</p></div>');
    expect(out.html).toContain("<br");
  });

  test("keeps <b> and <i>, which execCommand inserts", () => {
    const out = sanitizeResumeHtml('<div class="rsm"><p><b>a</b><i>b</i></p></div>');
    expect(out.html).toContain("<b>a</b>");
    expect(out.html).toContain("<i>b</i>");
  });
});

describe("what must not survive", () => {
  test("strips event handlers", () => {
    const out = sanitizeResumeHtml('<div class="rsm"><img src=x onerror="alert(1)"><p>ok</p></div>');
    expect(out.html).not.toContain("onerror");
    expect(out.html).not.toContain("<img");
  });

  test("strips <script> AND its contents, not just the tag", () => {
    const out = sanitizeResumeHtml('<div class="rsm"><script>alert(1)</script><p>ok</p></div>');
    expect(out.html).not.toContain("alert(1)");
  });

  test("rejects a javascript: href but keeps the link text", () => {
    const out = sanitizeResumeHtml('<div class="rsm"><a href="javascript:alert(1)">t</a></div>');
    expect(out.html).not.toContain("javascript:");
    expect(out.html).toContain("t");
  });

  test("keeps a mailto: href", () => {
    const out = sanitizeResumeHtml('<div class="rsm"><a href="mailto:a@b.com">m</a></div>');
    expect(out.html).toContain("mailto:a@b.com");
  });

  test("drops on-screen page guides, which rsm-page-guides.js appends INSIDE .rsm", () => {
    const guide =
      '<div class="rsm-page-guide"><div class="rsm-page-guide-tick"></div>' +
      '<span class="rsm-page-guide-label">Page 2</span></div>';
    const out = sanitizeResumeHtml('<div class="rsm"><p>keep</p>' + guide + "</div>");
    expect(out.html).not.toContain("rsm-page-guide");
    expect(out.html).not.toContain("Page 2");
    expect(out.html).toContain("keep");
  });
});

describe("refusals", () => {
  test("refuses a document with no .rsm root", () => {
    const out = sanitizeResumeHtml("<p>orphan</p>");
    expect(out.html).toBeUndefined();
    expect(out.error).toMatch(/rsm/i);
  });

  test("refuses oversize input with a stated reason", () => {
    const big = '<div class="rsm"><p>' + "x".repeat(MAX_HTML_BYTES) + "</p></div>";
    const out = sanitizeResumeHtml(big);
    expect(out.html).toBeUndefined();
    expect(out.error).toMatch(/too large|512/i);
  });
});

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { renderBody } from "./resume-render/render";
import type { CareerRecord } from "./resume-render/render";
import career from "./resume-render/content/resume.json";

describe("the shipped career record survives sanitization unchanged", () => {
  const FIXTURE = join(__dirname, "__fixtures__", "resume-sanitized.html");

  test("sanitizing the full render matches the checked-in fixture", () => {
    const rendered = renderBody(career as CareerRecord);
    const out = sanitizeResumeHtml(rendered);
    expect(out.error).toBeUndefined();
    expect(existsSync(FIXTURE)).toBe(true);
    expect(out.html).toBe(readFileSync(FIXTURE, "utf8"));
  });

  test("every <strong> in the career record survives", () => {
    const rendered = renderBody(career as CareerRecord);
    const before = (rendered.match(/<strong>/g) || []).length;
    const after = ((sanitizeResumeHtml(rendered).html || "").match(/<strong>/g) || []).length;
    expect(before).toBeGreaterThan(0);
    expect(after).toBe(before);
  });
});
