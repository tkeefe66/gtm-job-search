//
// The allowlist is derived from THREE sources, not one. An earlier design took
// it from renderBody's literal tag output, which is wrong twice:
//
//  1. render.js does not escape bullet text (:182), role title (:176) or the
//     <b> interpolations (:188,:200), and content/resume.json carries 22
//     <strong> tags. A list without `strong` silently strips every bold run
//     from every archived résumé.
//  2. What gets saved is contentEditable output, not renderer output. Enter
//     inserts <br>; execCommand inserts <b>/<i>. Dropping those deletes a
//     user's edits with no message — likelier than the <img onerror> paste
//     this module is built for.
//
// The `style` exception is real too: render.js:196 emits
// style="margin-bottom:0" on the last section on every render, and stripping it
// restores a bottom margin that at a page boundary is one page versus two.
import sanitizeHtml from "sanitize-html";
import { TOKEN_STYLE_RULES } from "@/lib/resume-design-tokens";

export const MAX_HTML_BYTES = 512 * 1024;

const ALLOWED_TAGS = [
  "div", "span", "p", "b", "strong", "i", "em", "u", "br",
  "section", "header", "h1", "h2", "h3",
  "ul", "ol", "li", "dl", "dt", "dd", "a",
];

// Matches `rsm` and `rsm-anything`. No /u flag: the build typechecks at ES5.
const RSM_CLASS = /^rsm(-[a-z0-9-]+)?$/;

// rsm-page-guides.js appends its overlay INSIDE the .rsm element (:138) and puts
// the styles in document.head (:59), so the nodes travel with a capture while
// their styling does not. Its @media print hide (:57) is why this never showed
// up in printing.
const PAGE_GUIDE_CLASS = /(^|\s)rsm-page-guide/;

export function sanitizeResumeHtml(input: string): { html?: string; error?: string } {
  const bytes = Buffer.byteLength(input, "utf8");
  if (bytes > MAX_HTML_BYTES) {
    return {
      error:
        "That résumé is too large to save (" +
        Math.round(bytes / 1024) +
        " KB; the limit is 512 KB). Try removing pasted images or formatting.",
    };
  }

  const html = sanitizeHtml(input, {
    allowedTags: ALLOWED_TAGS,
    // `div: ["style"]` carries the chat's per-document design tokens, which
    // renderBody puts on the .rsm root and useResumeCapture therefore captures.
    // THE allowedStyles.div ENTRY BELOW IS NOT OPTIONAL: sanitize-html's
    // filterCss does `allowedStyles[selector] || allowedStyles['*']` and, when
    // neither key exists, returns every declaration UNFILTERED — so this
    // attribute without that rule set opens arbitrary inline CSS on all ~40
    // divs renderBody emits plus whatever contentEditable produces. A test
    // pins the pairing. allowedStyles is keyed by TAG, never by class, so this
    // permits allowlisted custom properties on any div; that is accepted
    // deliberately, because the VALUE allowlist is what makes it safe.
    allowedAttributes: { "*": ["class"], a: ["href"], section: ["style"], div: ["style"] },
    allowedClasses: { "*": [RSM_CLASS] },
    allowedStyles: { section: { "margin-bottom": [/^0$/] }, div: TOKEN_STYLE_RULES },
    allowedSchemes: ["http", "https", "mailto"],
    // nonTextTags is DELIBERATELY not overridden. Its default
    // ['script','style','textarea','option'] is what drops <script>'s CONTENTS
    // rather than only its tag — a "script stripped" test would otherwise pass
    // while the payload survived as visible text.
    exclusiveFilter: (frame) =>
      PAGE_GUIDE_CLASS.test((frame.attribs && frame.attribs.class) || ""),
  });

  // document.css:5 scopes the whole design to `.rsm`. Capturing one level too
  // deep loses that root and the saved résumé renders as unstyled body text —
  // invisible until after the row is written, so it is refused here instead.
  if (!/<div[^>]*class="[^"]*\brsm\b[^"]*"/.test(html)) {
    return { error: "That résumé could not be saved: its .rsm document root is missing." };
  }

  return { html };
}
