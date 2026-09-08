// lib/rsm-page-guides.test.ts
//
// public/resume-design/rsm-page-guides.js is a browser IIFE with no exports, and this
// repo has no DOM test environment — so the file is loaded against a hand-built stub
// that implements exactly the handful of DOM calls it makes. That is enough to EXECUTE
// collectFragments/measure/draw rather than grep the source for a guard, which is the
// difference between proving the behaviour and proving the text.
//
// The stub reports geometry from fixed numbers, so nothing here depends on font metrics
// or a real layout; what is under test is the WALK, not the measurement.
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

type Rect = { top: number; bottom: number; height: number; width: number; left: number; right: number };

class El {
  className: string;
  children: El[] = [];
  style: Record<string, string> = {};
  innerHTML = "";
  textContent = "";
  parent: El | null = null;
  private top: number;
  private h: number;

  constructor(className: string, top = 0, height = 0) {
    this.className = className;
    this.top = top;
    this.h = height;
  }
  get classList() {
    return { contains: (c: string) => this.className.split(/\s+/).indexOf(c) !== -1 };
  }
  getBoundingClientRect(): Rect {
    // A guide is absolutely positioned: its own box is a hairline at `style.top`.
    if (this.classList.contains("rsm-page-guide")) {
      const t = parseFloat(this.style.top || "0");
      return { top: t, bottom: t, height: 0, width: 0, left: 0, right: 0 };
    }
    return { top: this.top, bottom: this.top + this.h, height: this.h, width: 0, left: 0, right: 0 };
  }
  appendChild(c: El) { c.parent = this; this.children.push(c); return c; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); }
  private descendants(): El[] {
    return this.children.reduce<El[]>((a, c) => a.concat([c], c.descendants()), []);
  }
  querySelectorAll(sel: string): El[] {
    if (sel === ":scope > .rsm-page-guide") return this.children.filter((c) => c.classList.contains("rsm-page-guide"));
    if (sel === ":scope > .rsm-role") return this.children.filter((c) => c.classList.contains("rsm-role"));
    if (sel === ".rsm-bullets > li") {
      const uls = this.descendants().filter((d) => d.classList.contains("rsm-bullets"));
      return uls.reduce<El[]>((a, u) => a.concat(u.children), []);
    }
    if (sel === "doc-page") return [docPage];
    if (sel === "doc-page .rsm") return [rsm];
    return [];
  }
  querySelector(sel: string): El | null {
    if (sel === ":scope > .rsm") return this.children.filter((c) => c.classList.contains("rsm"))[0] || null;
    return this.querySelectorAll(sel)[0] || null;
  }
  getAttribute(name: string): string | null {
    return name === "margin" ? "0.68in" : null;
  }
}

let docPage: El;
let rsm: El;
let measure: () => { pages: number; lastPageFill: number } | null;

/** One role: a head block plus `bullets` bullets, laid out from `top`. */
function role(top: number, bulletCount: number, bulletH = 40, headH = 44): { el: El; bottom: number } {
  const r = new El("rsm-role", top, 0);
  const ul = new El("rsm-bullets", top + headH, bulletCount * bulletH);
  for (let i = 0; i < bulletCount; i++) ul.appendChild(new El("", top + headH + i * bulletH, bulletH));
  r.appendChild(ul);
  const bottom = top + headH + bulletCount * bulletH;
  (r as unknown as { getBoundingClientRect: () => Rect }).getBoundingClientRect = () =>
    ({ top, bottom, height: bottom - top, width: 0, left: 0, right: 0 });
  return { el: r, bottom };
}

beforeEach(() => {
  // A document ~1810px tall against a 925.44px page: two pages, not one.
  rsm = new El("rsm", 0, 0);
  const section = new El("rsm-section", 0, 0);
  let y = 0;
  for (let i = 0; i < 6; i++) { const r = role(y, 6); section.appendChild(r.el); y = r.bottom + 18; }
  (section as unknown as { getBoundingClientRect: () => Rect }).getBoundingClientRect = () =>
    ({ top: 0, bottom: y, height: y, width: 0, left: 0, right: 0 });
  rsm.appendChild(section);
  (rsm as unknown as { getBoundingClientRect: () => Rect }).getBoundingClientRect = () =>
    ({ top: 0, bottom: y, height: y, width: 0, left: 0, right: 0 });

  docPage = new El("doc-page", 0, 0);
  docPage.appendChild(rsm);

  const head = new El("head");
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = {
    readyState: "complete",
    head,
    getElementById: () => ({}),                       // the <style> is already installed
    createElement: (t: string) => new El(t),
    querySelector: (s: string) => (s === "doc-page" ? docPage : null),
    querySelectorAll: (s: string) => (s === "doc-page" ? [docPage] : s === "doc-page .rsm" ? [rsm] : []),
    fonts: null,
  };
  g.getComputedStyle = () => ({ position: "relative" });
  g.addEventListener = () => {};
  g.MutationObserver = class { observe() {} };
  g.requestAnimationFrame = (fn: () => void) => fn();
  g.self = g;
  g.window = g;

  const src = fs.readFileSync(path.join(process.cwd(), "public/resume-design/rsm-page-guides.js"), "utf8");
  // eslint-disable-next-line no-new-func
  new Function(src)();
  measure = (g.__rsmMeasure as typeof measure);
});

describe("rsm-page-guides measure()", () => {
  it("reports the real page count for a two-page document", () => {
    expect(measure()!.pages).toBe(2);
  });

  // Mutation: removing the `rsm-page-guide` skip from collectFragments. The guides are
  // appended as children of .rsm, so on the next walk the LAST child is a guide — a
  // zero-height box at the first break — and the document's real end disappears.
  // This is the live experiment: measure with the guides stripped (the true value, which
  // is what draw() always sees because it removes them first), then measure again with
  // them back in the DOM. Asserting only that two guided calls agree does NOT bite — with
  // the bug both are wrong in the same way, which is how it survived to production.
  it("measures the same with its own guides in the DOM as without them", () => {
    const guides = rsm.querySelectorAll(":scope > .rsm-page-guide");
    expect(guides.length).toBeGreaterThan(0);
    guides.forEach((g) => g.remove());
    const truth = measure()!;
    guides.forEach((g) => rsm.appendChild(g));
    const guided = measure()!;
    expect(guided.pages).toBe(truth.pages);
    expect(guided.lastPageFill).toBeCloseTo(truth.lastPageFill, 6);
  });

  // Mutation: measuring against the full paper height instead of subtracting both margins.
  it("subtracts both page margins from the paper height", () => {
    // 1810px of content against letter (1056px) minus 2 x 0.68in (65.28px) = 925.44.
    expect(Math.ceil(1810 / 925.44)).toBe(measure()!.pages);
  });
});
