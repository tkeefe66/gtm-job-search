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

  it("rewrites an em dash in prose into a comma", () => {
    expect(sanitizeBulletText("Built the spine \u2014 models, analysis \u2014 and the team").text).toBe(
      "Built the spine, models, analysis, and the team"
    );
  });

  it("rewrites an em dash between numbers into a hyphen, not a comma", () => {
    expect(sanitizeBulletText("Ran the program 2019\u20142024.").text).toBe("Ran the program 2019-2024.");
  });

  it("accepts text that is only over the cap before its em dashes are rewritten", () => {
    // " \u2014 " is three characters and becomes two, so a rewrite that ran
    // AFTER the length check would reject text that fits.
    const input = "x".repeat(MAX_BULLET_CHARS - 3) + " \u2014 y"; // 2003 raw, 2000 rewritten
    const res = sanitizeBulletText(input);
    expect(res.error).toBeUndefined();
    expect(res.text).toBeDefined();
    expect(res.text).not.toContain("\u2014");
  });

  it("rejects input under the raw cap that expands past it after escaping", () => {
    // Each '<' escapes to '&lt;', 4x. Sized off the cap rather than a literal
    // so raising MAX_BULLET_CHARS cannot turn this into an acceptance test,
    // which is exactly what the 600-era literal 400 did when the cap moved.
    const input = "<".repeat(Math.floor(MAX_BULLET_CHARS / 2)); // under the raw cap, 2x over once escaped
    const res = sanitizeBulletText(input);
    expect(res.text).toBeUndefined(); // rejection, not acceptance
    expect(res.error).toBeDefined();
    expect(res.error).toContain("grew to"); // post-escape error, not raw-cap error
  });

  it("accepts a near-cap input that does not expand past the limit", () => {
    // Text that carries nothing the sanitizer escapes, so its post-escape
    // length equals its raw length and the cap is the only thing it has to
    // clear. The rejecting twin is the test above, where 400 raw '<'
    // characters escape to 1600.
    const input = "A valid bullet with some text " + "x".repeat(Math.floor(MAX_BULLET_CHARS / 2) - 30);
    const res = sanitizeBulletText(input);
    expect(res.text).toBeDefined(); // acceptance
    expect(res.error).toBeUndefined();
  });

  it("guarantees accepted output satisfies the length cap", () => {
    // The assertion used to sit inside `if (res.text)`, so an implementation
    // that rejected every input passed with zero assertions executed — the
    // branch's one genuinely non-biting test, guarding the escaping-growth
    // boundary this branch specifically added. Acceptance is now asserted
    // first, so a blanket-rejecting implementation fails here.
    const validInputs = [
      "A simple bullet.",
      "Owned a <strong>$100M+</strong> pipeline.",
      "Led <b>growth</b> & <em>marketing</em> efforts.",
      "x".repeat(MAX_BULLET_CHARS - 10), // near-cap legitimate text
    ];
    for (const input of validInputs) {
      const res = sanitizeBulletText(input);
      expect(res.error).toBeUndefined();
      expect(res.text).toBeDefined();
      expect((res.text as string).length).toBeLessThanOrEqual(MAX_BULLET_CHARS);
    }
  });
});
