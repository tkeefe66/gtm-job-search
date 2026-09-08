import { describe, expect, it } from "vitest";
import { isClearableTarget } from "@/lib/clearable-text";
import { effectiveCareer } from "@/lib/effective-career";
import type { CareerRecord } from "@/lib/resume-render/render";

function record(): CareerRecord {
  return {
    identity: { name: "Tom Keefe", contacts: [] },
    positioning: [{ id: "gtm", themes: [], tagline: "A tagline.", summary: "A summary." }],
    roles: [
      {
        id: "r1",
        title: "Director",
        org: "Acme",
        dates: "2020 – Present",
        bullets: [{ id: "b1", priority: 1, themes: ["ops"], text: "Did a thing." }],
      },
    ],
    advisory: [],
    education: [],
    rules: { taper: [3], themes: [], compressAfter: null },
  };
}

describe("isClearableTarget", () => {
  // Mutation this catches: treating every text target as clearable. A résumé
  // whose header name is blank has no name on it, and an emptied bullet renders
  // as a stray dash — removing a bullet is drop_bullet's job, not set_text's.
  it("allows the two optional slots and nothing else", () => {
    expect(isClearableTarget("summary")).toBe(true);
    expect(isClearableTarget("positioning")).toBe(true);
    expect(isClearableTarget("name")).toBe(false);
    expect(isClearableTarget("bullet:r1:b1")).toBe(false);
  });
});

describe("clearing a text slot", () => {
  // Mutation this catches: routing an empty override through `cleaned`, which
  // returns null because sanitizeBulletText refuses empty text — so the clear
  // is silently ignored and the old tagline stays on the page while the chat
  // reports success. That is exactly what "remove the text under my name"
  // did before this existed.
  it("empties the tagline when asked to clear it", () => {
    const { career } = effectiveCareer(record(), [], { positioning: "" });
    expect(career.positioning[0].tagline).toBe("");
  });

  it("empties the summary when asked to clear it", () => {
    const { career } = effectiveCareer(record(), [], { summary: "   " });
    expect(career.positioning[0].summary).toBe("");
  });

  // Mutation this catches: applying the clear to the FIRST variant only.
  // effectiveCareer writes text overrides across every positioning variant —
  // CLAUDE.md records that summary edits are architecturally flattened this way
  // — so a clear that missed the others would reappear on a set_positioning.
  it("clears across every positioning variant", () => {
    const r = record();
    r.positioning.push({ id: "ai", themes: [], tagline: "Another.", summary: "Another." });
    const { career } = effectiveCareer(r, [], { positioning: "" });
    expect(career.positioning.map((p) => p.tagline)).toEqual(["", ""]);
  });

  // Mutation this catches: letting a blank NAME through the clear path. The
  // header would render with no name at all.
  it("refuses to clear the name", () => {
    const { career } = effectiveCareer(record(), [], { name: "" });
    expect(career.identity.name).toBe("Tom Keefe");
  });

  // Mutation this catches: clearing a BULLET's text, which renders as an empty
  // list item rather than removing the bullet.
  it("refuses to clear a bullet", () => {
    const { career } = effectiveCareer(record(), [], { "bullet:r1:b1": "" });
    expect(career.roles[0].bullets[0].text).toBe("Did a thing.");
  });

  // Mutation this catches: confusing "clear it" with "leave it alone". An
  // absent key must not blank the slot.
  it("leaves a slot alone when no override names it", () => {
    const { career } = effectiveCareer(record(), [], {});
    expect(career.positioning[0].tagline).toBe("A tagline.");
  });

  // Mutation this catches: isClearRequest ignoring the VALUE and treating any
  // override on a clearable slot as a removal — which turns every tagline and
  // summary EDIT into a deletion. Every other test here passes a blank value,
  // so none of them can tell "clear on empty" from "clear on anything"; this is
  // the only case that separates them.
  it("still REPLACES a clearable slot when the override has text", () => {
    const { career } = effectiveCareer(record(), [], { positioning: "A new tagline." });
    expect(career.positioning[0].tagline).toBe("A new tagline.");
  });

  it("still replaces the summary when the override has text", () => {
    const { career } = effectiveCareer(record(), [], { summary: "A new summary." });
    expect(career.positioning[0].summary).toBe("A new summary.");
  });
});
