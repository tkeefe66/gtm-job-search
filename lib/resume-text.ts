/**
 * The ONE boundary for text this app did not author itself — a chat `set_text`
 * value, or a proposed overlay bullet.
 *
 * Why this has to exist: render.js:182 emits '<li>' + b.text + '</li>' with NO
 * escaping (lib/resume-sanitize.ts:5-8 documents that deliberately — the career
 * record carries 22 <strong> tags that must survive), and renderBody's output
 * reaches the DOM through dangerouslySetInnerHTML on the CLIENT
 * (ResumeDocument.tsx:89), where sanitizeResumeHtml — which runs server-side on
 * Save only — has never run. So a model-authored bullet is a script tag away
 * from executing in the user's browser.
 *
 * ESCAPES rather than strips. sanitize-html's default drops a disallowed tag
 * and keeps its text, which would silently delete part of what the user asked
 * for; `disallowedTagsMode: "escape"` renders the payload as visible, inert
 * text instead, so a blocked edit is something the user can SEE.
 *
 * Applied at three boundaries, because each alone has a bypass: operation
 * validation (lib/resume-ops.ts), the effectiveCareer merge (so a row written
 * by an earlier build cannot render unsafe), and sanitizeResumeHtml on Save.
 */
import sanitizeHtml from "sanitize-html";

export const MAX_BULLET_CHARS = 2000;

/**
 * Em dashes are banned from résumé text outright. The user's rule, and it is
 * absolute: the character never appears in a document this app produces. The
 * BAN is enforced here rather than left to the prompt, because a rule the
 * model is merely told about is a rule that holds until the turn it doesn't,
 * and nothing downstream would catch it — render.js emits bullet text
 * verbatim.
 *
 * It REWRITES rather than refuses: an em dash is punctuation, not an attack,
 * and rejecting the turn would throw away a good edit over a character the
 * user does not care to see. Between digits it becomes a hyphen (a range:
 * "2019—2024"); anywhere else the surrounding spaces collapse into a comma,
 * which is what an em dash is standing in for in prose.
 */
export function stripEmDashes(input: string): string {
  return input
    .replace(/(\d)\s*[\u2014\u2015]\s*(\d)/g, "$1-$2")
    .replace(/\s*[\u2014\u2015]\s*/g, ", ");
}

export function sanitizeBulletText(input: string): { text?: string; error?: string } {
  if (typeof input !== "string" || input.trim() === "") {
    return { error: "That text is empty." };
  }
  const dashed = stripEmDashes(input);
  if (dashed.length > MAX_BULLET_CHARS) {
    return {
      error:
        "That text is too long (" + dashed.length + " characters; the limit is " + MAX_BULLET_CHARS + ").",
    };
  }
  const text = sanitizeHtml(dashed, {
    allowedTags: ["strong", "b", "em", "i"],
    allowedAttributes: {},
    allowedSchemes: [],
    disallowedTagsMode: "escape",
  });
  // Escaping never shrinks text, only grows it — < becomes &lt; (4x expansion in worst case).
  // The raw-input check above is a cheap early guard, but does not guarantee the output length.
  // Task 7 consumes this text directly with no re-check, so we must enforce the cap on output.
  if (text.length > MAX_BULLET_CHARS) {
    return {
      error:
        "That text grew to " +
        text.length +
        " characters after escaping special characters; the limit is " +
        MAX_BULLET_CHARS +
        ".",
    };
  }
  return { text };
}
