/**
 * The ONE boundary for text this app did not author itself — a chat `set_text`
 * value, or a proposed overlay bullet.
 *
 * Why this has to exist: render.js:155 emits '<li>' + b.text + '</li>' with NO
 * escaping (lib/resume-sanitize.ts:5-8 documents that deliberately — the career
 * record carries 22 <strong> tags that must survive), and renderBody's output
 * reaches the DOM through dangerouslySetInnerHTML on the CLIENT
 * (ResumeDocument.tsx:80), where sanitizeResumeHtml — which runs server-side on
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

export const MAX_BULLET_CHARS = 600;

export function sanitizeBulletText(input: string): { text?: string; error?: string } {
  if (typeof input !== "string" || input.trim() === "") {
    return { error: "That text is empty." };
  }
  if (input.length > MAX_BULLET_CHARS) {
    return {
      error:
        "That text is too long (" + input.length + " characters; the limit is " + MAX_BULLET_CHARS + ").",
    };
  }
  const text = sanitizeHtml(input, {
    allowedTags: ["strong", "b", "em", "i"],
    allowedAttributes: {},
    allowedSchemes: [],
    disallowedTagsMode: "escape",
  });
  return { text };
}
