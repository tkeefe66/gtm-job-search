// lib/resume-download.ts
//
// A downloaded résumé is a standalone document that must print like the app
// prints. That is why doc-page.js is inlined rather than omitted: its own source
// says "never write your own @page rule or hard-code paper dimensions in the
// content" (:30), and there are NO @page rules anywhere in the token CSS — all
// print geometry lives in the component, which at print injects
// @page { margin: 0 } to deny Chrome its header/footer margin box and moves the
// visual margin onto the sheet's own padding (:118-120). spacing.css:10 also
// records that --rail: 132px was sized against doc-page.js's global
// text-wrap:balance on headings, so a file without it wraps section labels
// differently — the exact defect that forced 96px -> 132px.
//
// NOT self-contained in one respect: tokens/fonts.css @imports Newsreader and
// JetBrains Mono from Google Fonts, so a file opened offline falls back to the
// declared Georgia/Times and system-mono stacks.

/**
 * Bumped BY HAND whenever anything in public/resume-design/tokens/ changes.
 * Stamped onto every saved row so a résumé authored against an older design is
 * identifiable rather than merely suspect — the row stores markup, and its
 * appearance comes from those files at view time.
 */
export const DESIGN_VERSION = "2026-09-08c";

/**
 * The one definition of the default <doc-page> margin. `saved_resumes.page_margin`
 * (Task 14) is null on every row that never overrode it, and a null there means
 * "use this" — never "" and never a second hardcoded literal. Every renderer of a
 * margin (ResumeDocument.tsx's draft, SavedResumePanel.tsx's archive screen, and
 * buildDownloadHtml's standalone export below) imports this rather than repeating
 * "0.68in", which is exactly how the download path drifted from the other two
 * before this constant existed.
 */
export const DEFAULT_PAGE_MARGIN = "0.68in";

/** Must equal styles.css's @import order. A test asserts it. */
export const TOKEN_CSS_FILES = [
  "fonts.css",
  "colors.css",
  "typography.css",
  "spacing.css",
  "elevation.css",
  "document.css",
];

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildDownloadHtml(args: {
  markup: string;
  css: string;
  docPageJs: string;
  title: string;
  /** Omit for the default. A saved résumé's own `pageMargin` column belongs here —
   *  without it, a non-default margin reverts silently on download, the same
   *  symptom Task 14 fixed on the draft and saved screens, reached through a
   *  fourth surface. */
  pageMargin?: string | null;
}): string {
  return (
    "<!doctype html>\n" +
    '<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    "<title>" +
    escapeHtml(args.title) +
    "</title>\n<style>\n" +
    args.css +
    "\n</style>\n</head>\n<body>\n" +
    '<doc-page margin="' +
    escapeHtml(args.pageMargin || DEFAULT_PAGE_MARGIN) +
    '">' +
    args.markup +
    "</doc-page>\n<script>\n" +
    args.docPageJs +
    "\n</script>\n</body>\n</html>\n"
  );
}

/**
 * No \p{L} and no /u flag: the build typechecks at ES5, where both are errors.
 * The ASCII fallback truncates non-ASCII company names, which is acceptable for
 * a filename (lib/role-key.ts's NAME_SEPARATORS exists because it was NOT
 * acceptable for an identity key).
 */
export function downloadFilename(roleTitle: string, company: string, createdAt: string): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  const day = createdAt.slice(0, 10);
  return "resume-" + slug(company) + "-" + slug(roleTitle) + "-" + day + ".html";
}
