import { describe, it, expect } from "vitest";
import {
  DESIGN_TOKENS, parseTokenValue, styleAttributeFor, parsePageMargin, TOKEN_STYLE_RULES,
} from "@/lib/resume-design-tokens";
import fs from "node:fs";
import path from "node:path";

describe("design token allowlist", () => {
  it("only lists tokens the stylesheets actually consume", () => {
    const dir = path.join(process.cwd(), "public/resume-design");
    const css = fs
      .readdirSync(path.join(dir, "tokens"))
      .map((f) => fs.readFileSync(path.join(dir, "tokens", f), "utf8"))
      .join("\n");
    for (const t of DESIGN_TOKENS) {
      expect(css.indexOf("var(" + t.name), t.name + " has no consumer").toBeGreaterThan(-1);
    }
  });

  it("has a style rule for every allowlisted token and no others", () => {
    expect(Object.keys(TOKEN_STYLE_RULES).sort()).toEqual(DESIGN_TOKENS.map((t) => t.name).sort());
  });
});

describe("parseTokenValue", () => {
  it("accepts a bounded length in an allowed unit", () => {
    expect(parseTokenValue("--rail", "120px").value).toBe("120px");
  });

  it("rejects an unknown token", () => {
    expect(parseTokenValue("--page-width", "9in").error).toContain("not adjustable");
  });

  it("rejects a length outside its bounds", () => {
    expect(parseTokenValue("--rail", "9000px").error).toBeDefined();
  });

  it("rejects an unknown unit", () => {
    expect(parseTokenValue("--rail", "12vw").error).toBeDefined();
  });

  it("rejects a CSS injection attempt", () => {
    expect(parseTokenValue("--rail", "1px } .rsm { background:url(http://e)").error).toBeDefined();
    expect(parseTokenValue("--rail", "url(http://evil/x)").error).toBeDefined();
  });

  it("accepts oklch, hex and a named colour for a colour token", () => {
    expect(parseTokenValue("--link", "oklch(0.62 0.012 40)").value).toBe("oklch(0.62 0.012 40)");
    expect(parseTokenValue("--link", "#1a2b3c").value).toBe("#1a2b3c");
    expect(parseTokenValue("--link", "black").value).toBe("black");
  });

  it("rejects a colour that is a function call other than oklch", () => {
    expect(parseTokenValue("--link", "image-set(x)").error).toBeDefined();
  });
});

describe("styleAttributeFor", () => {
  it("renders only valid declarations, in a stable order", () => {
    expect(styleAttributeFor({ "--rail": "120px", "--link": "black" })).toBe("--link:black;--rail:120px");
  });

  it("omits anything invalid rather than emitting it", () => {
    expect(styleAttributeFor({ "--rail": "9000px" })).toBe("");
  });
});

describe("parsePageMargin", () => {
  it("accepts inches within bounds", () => {
    expect(parsePageMargin("0.5in").value).toBe("0.5in");
  });
  it("rejects out-of-bounds and bad units", () => {
    expect(parsePageMargin("9in").error).toBeDefined();
    expect(parsePageMargin("0.5em").error).toBeDefined();
  });
});
