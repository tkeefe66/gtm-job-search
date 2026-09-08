import { describe, expect, it } from "vitest";
import { HOUSE_RULES, evaluateHouseStyle, houseRulesBlock } from "@/lib/house-style";
import type { CareerRecord, ResumeSelection } from "@/lib/resume-render/render";

/** Four roles, three bullets each in the pool, compressAfter 3 — so roles 1-3
 *  render and role 4 is a one-line row. Deliberately deeper than the rules
 *  need: a fixture with as many roles as the taper has entries cannot show
 *  that the rules stop at the rendered set. */
function record(compressAfter: number | null = 3): CareerRecord {
  const role = (id: string, title: string) => ({
    id,
    title,
    org: "Acme",
    dates: "2020 – Present",
    bullets: [
      { id: id + "-a", priority: 1, themes: ["ops"], text: "A." },
      { id: id + "-b", priority: 2, themes: ["ops"], text: "B." },
      { id: id + "-c", priority: 3, themes: ["ops"], text: "C." },
    ],
  });
  return {
    identity: { name: "Tom Keefe", contacts: [] },
    positioning: [{ id: "gtm", themes: [], tagline: "A tagline.", summary: "A summary." }],
    roles: [role("r1", "Director"), role("r2", "Principal"), role("r3", "Manager"), role("r4", "Analyst")],
    advisory: [],
    education: [],
    rules: { taper: [3, 2, 1, 1], themes: [], compressAfter },
  };
}

function selection(perRole: Record<string, string[]>): ResumeSelection {
  return { positioningId: "gtm", bullets: perRole };
}

/** Descending 3/2/1 across the rendered roles — the shape the rules want. */
function healthy(): ResumeSelection {
  return selection({
    r1: ["r1-a", "r1-b", "r1-c"],
    r2: ["r2-a", "r2-b"],
    r3: ["r3-a"],
    r4: ["r4-a"],
  });
}

function ids(findings: { rule: string }[]): string[] {
  return findings.map((f) => f.rule).sort();
}

describe("evaluateHouseStyle", () => {
  it("finds nothing wrong with a well-shaped document", () => {
    expect(evaluateHouseStyle(record(), healthy())).toEqual([]);
  });

  // Mutation this catches: comparing only the first pair, or using >= so a FLAT
  // taper passes. [3,3,3] is exactly what "give every role five bullets"
  // produces, and it reads as though a 2013 job matters as much as the current
  // one — the failure that prompted this rule.
  it("flags a flat taper, not only an increasing one", () => {
    const flat = selection({
      r1: ["r1-a", "r1-b", "r1-c"],
      r2: ["r2-a", "r2-b", "r2-c"],
      r3: ["r3-a", "r3-b", "r3-c"],
      r4: ["r4-a"],
    });
    expect(ids(evaluateHouseStyle(record(), flat))).toContain("taper-descends");
  });

  // Mutation this catches: checking the taper ARRAY rather than the rendered
  // selection. The array is advisory — effectiveDocument can override it, a
  // per-role bullet list wins over it, and a role can run out of pool — so only
  // the selection says what is actually on the page.
  it("flags an increasing taper", () => {
    const rising = selection({
      r1: ["r1-a"],
      r2: ["r2-a", "r2-b"],
      r3: ["r3-a", "r3-b", "r3-c"],
      r4: ["r4-a"],
    });
    expect(ids(evaluateHouseStyle(record(), rising))).toContain("taper-descends");
  });

  // Mutation this catches: counting roles beyond compressAfter. Role 4 renders
  // as a one-line row with NO bullets, so including it would report a violation
  // on every correct document — and a fixture whose roles all render could not
  // tell the difference.
  it("ignores roles past compressAfter", () => {
    const r = record(3);
    const sel = selection({
      r1: ["r1-a", "r1-b", "r1-c"],
      r2: ["r2-a", "r2-b"],
      r3: ["r3-a"],
      r4: [],
    });
    expect(evaluateHouseStyle(r, sel)).toEqual([]);
  });

  // Mutation this catches: treating an empty rendered role as acceptable.
  // render.js drops the whole ROLE when no bullets survive, so this is the
  // silent role-vanishing failure — the document loses a job with no message.
  it("flags a rendered role with no bullets", () => {
    const gap = selection({
      r1: ["r1-a", "r1-b", "r1-c"],
      r2: [],
      r3: ["r3-a"],
      r4: ["r4-a"],
    });
    expect(ids(evaluateHouseStyle(record(), gap))).toContain("no-empty-role");
  });

  // Mutation this catches: letting a tagline stand in for the summary, which was
  // the rule until the 2026-09-08 design sync. The masthead now renders the name
  // and one contact line only, so a tagline reaches no reader — accepting it
  // would pass a document that opens with nothing.
  it("flags a summary-less document even when a tagline is set", () => {
    const r = record();
    r.positioning[0].tagline = "Still here, still unrendered.";
    r.positioning[0].summary = "";
    expect(ids(evaluateHouseStyle(r, healthy()))).toContain("positioning-present");
  });

  it("accepts a summary with no tagline", () => {
    const r = record();
    r.positioning[0].tagline = "";
    expect(evaluateHouseStyle(r, healthy())).toEqual([]);
  });

  // Mutation this catches: reading positioning[0] rather than the SELECTED
  // variant. A fixture with one variant cannot tell them apart.
  it("reads the selected positioning variant, not the first", () => {
    const r = record();
    r.positioning.push({ id: "ai", themes: [], tagline: "", summary: "" });
    const sel = { ...healthy(), positioningId: "ai" };
    expect(ids(evaluateHouseStyle(r, sel))).toContain("positioning-present");
  });
});

describe("houseRulesBlock", () => {
  // Mutation this catches: rendering the rule STATEMENTS without the rationale.
  // "Taper must not increase" teaches nothing; the reason is what lets the model
  // apply the rule to a case the statement does not literally cover.
  it("carries each rule's rationale, not just its statement", () => {
    const block = houseRulesBlock();
    for (const rule of HOUSE_RULES) {
      expect(block).toContain(rule.statement);
      expect(block).toContain(rule.rationale);
    }
  });
});
