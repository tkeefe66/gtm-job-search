import { describe, it, expect } from "vitest";
import { sanitizeBulletText, MAX_BULLET_CHARS } from "@/lib/resume-text";

describe("sanitizeBulletText", () => {
  it("keeps a legitimate <strong> byte-identically", () => {
    const input = "Owned a <strong>$100M+</strong> pipeline engine.";
    expect(sanitizeBulletText(input).text).toBe(input);
  });

  it("keeps the other three inline tags", () => {
    expect(sanitizeBulletText("<b>a</b> <i>b</i> <em>c</em>").text).toBe("<b>a</b> <i>b</i> <em>c</em>");
  });

  it("escapes an image payload rather than deleting it", () => {
    const out = sanitizeBulletText('Led <img src=x onerror=alert(1)> the team').text!;
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
    expect(out).not.toContain("onerror=alert(1)>");
  });

  it("escapes a script tag and does not leave its contents as live markup", () => {
    const out = sanitizeBulletText("<script>alert(1)</script>").text!;
    expect(out).not.toContain("<script");
    expect(out).toContain("&lt;script&gt;");
  });

  it("drops an anchor's javascript: href by escaping the whole tag", () => {
    const out = sanitizeBulletText('<a href="javascript:alert(1)">x</a>').text!;
    expect(out).not.toContain("<a ");
    expect(out).toContain("&lt;a");
  });

  it("escapes a bare ampersand", () => {
    expect(sanitizeBulletText("Sales & Marketing").text).toBe("Sales &amp; Marketing");
  });

  it("rejects rather than truncates over the length cap", () => {
    const res = sanitizeBulletText("x".repeat(MAX_BULLET_CHARS + 1));
    expect(res.text).toBeUndefined();
    expect(res.error).toContain("too long");
  });

  it("rejects empty or whitespace-only text", () => {
    expect(sanitizeBulletText("   ").error).toBeDefined();
  });

  it("rejects input under the raw cap that expands past it after escaping", () => {
    // 400 raw chars of '<' → escapes to 1600 chars, well over 600 limit
    const input = "<".repeat(400);
    expect(input.length).toBe(400); // confirm input is under cap
    const res = sanitizeBulletText(input);
    expect(res.text).toBeUndefined(); // rejection, not acceptance
    expect(res.error).toBeDefined();
    expect(res.error).toContain("grew to"); // post-escape error, not raw-cap error
  });

  it("accepts a near-cap input that does not expand past the limit", () => {
    // 580 legitimate characters that escape to <630 chars should be rejected
    // but 400 + some text should fit: 400 chars + "test" = 404 raw -> stays under
    const input = "A valid bullet with some text " + "x".repeat(370);
    expect(input.length).toBeLessThanOrEqual(MAX_BULLET_CHARS);
    const res = sanitizeBulletText(input);
    expect(res.text).toBeDefined(); // acceptance
    expect(res.error).toBeUndefined();
  });

  it("guarantees accepted output satisfies the length cap", () => {
    // Test a variety of inputs that should pass, and verify all stay under cap
    const validInputs = [
      "A simple bullet.",
      "Owned a <strong>$100M+</strong> pipeline.",
      "Led <b>growth</b> & <em>marketing</em> efforts.",
      "x".repeat(590), // near-cap legitimate text
    ];
    for (const input of validInputs) {
      const res = sanitizeBulletText(input);
      if (res.text) {
        expect(res.text.length).toBeLessThanOrEqual(MAX_BULLET_CHARS);
      }
    }
  });
});
