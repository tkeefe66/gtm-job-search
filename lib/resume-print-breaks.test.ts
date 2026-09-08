import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * The vendored `public/resume-design/tokens/document.css` decides where a printed résumé
 * breaks, and no vitest test can lay out a page. What CAN be asserted here is the CASCADE:
 * which `break-inside` value actually wins for a given kind of section. That is the thing a
 * re-sync of the design system silently reverts — CLAUDE.md records two divergences already
 * lost that way — and it is the thing that put ~700px of white on page 1 in production.
 *
 * The resolver below is deliberately narrow. It understands exactly the selector shapes this
 * stylesheet uses for sections (`.rsm-section` and `.rsm-section:has(...)`), and nothing else,
 * so it cannot quietly "pass" a rule it failed to understand.
 */

const CSS = fs.readFileSync(
  path.join(process.cwd(), "public/resume-design/tokens/document.css"),
  "utf8",
);

type Rule = { selector: string; decls: string; order: number };

function rules(css: string): Rule[] {
  const out: Rule[] = [];
  // Comments carry prose with braces-free text, but strip them anyway so a commented-out
  // rule can never be read as live.
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(bare))) {
    for (const selector of m[1].split(",")) out.push({ selector: selector.trim(), decls: m[2], order: i++ });
  }
  return out;
}

/** Effective `break-inside` for a `.rsm-section` whose subtree contains the given classes. */
function breakInsideForSection(css: string, contains: string[]): string | undefined {
  const matched: { spec: number; order: number; value: string }[] = [];
  for (const r of rules(css)) {
    let applies = false;
    if (r.selector === ".rsm-section") applies = true;
    const has = /^\.rsm-section:has\(([^)]*)\)$/.exec(r.selector);
    if (has) applies = has[1].split(",").some((s) => contains.indexOf(s.trim()) !== -1);
    if (!applies) continue;
    const value = /(?:^|;)\s*break-inside\s*:\s*([^;]+)/.exec(r.decls)?.[1].trim();
    if (!value) continue;
    // Specificity, class-count only — every selector shape this file uses for a section is
    // classes alone, and `:has()` contributes its most specific argument.
    matched.push({ spec: (r.selector.match(/\./g) || []).length, order: r.order, value });
  }
  matched.sort((a, b) => (a.spec - b.spec) || (a.order - b.order));
  return matched.length ? matched[matched.length - 1].value : undefined;
}

describe("printed section fragmentation", () => {
  // Mutation: restoring `break-inside:avoid` for the experience section (the state a design-system
  // re-sync produces) — an unbreakable box taller than a page is pushed WHOLE to the next page,
  // which stranded ~700px of white under the summary on page 1 in production.
  it("lets the section holding the role entries fragment across pages", () => {
    expect(breakInsideForSection(CSS, [".rsm-role"])).not.toBe("avoid");
  });

  // Mutation: dropping `break-inside:avoid` from `.rsm-section` outright instead of exempting the
  // one section that can exceed a page — the short row sections (Advisory, Education) would then
  // split, stranding the rail label, which is `grid-row:1/span 99`, on the previous page.
  it("still refuses to split a section built from compressed rows", () => {
    expect(breakInsideForSection(CSS, [".rsm-rows"])).toBe("avoid");
  });

  // Mutation: deleting the `.rsm-role` break rules that replaced the role's own break-inside:avoid —
  // without them a role's header can be stranded at the foot of a page, away from its bullets.
  it("keeps a role's header attached to its first bullet", () => {
    const byName = (sel: string) => rules(CSS).filter((r) => r.selector === sel).map((r) => r.decls).join(";");
    expect(byName(".rsm-role-head")).toContain("break-after:avoid");
    expect(byName(".rsm-role-org")).toContain("break-after:avoid");
    expect(byName(".rsm-bullets li:first-child")).toContain("break-before:avoid");
  });
});
