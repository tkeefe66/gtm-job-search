// lib/draft-render.test.ts
import { describe, expect, it } from "vitest";
import { renderDraftHtml } from "@/lib/draft-render";
import { renderBody, selectBullets } from "@/lib/resume-render/render";
import type { CareerRecord } from "@/lib/resume-render/render";
import careerJson from "@/lib/resume-render/content/resume.json";

const career = careerJson as CareerRecord;
const themes = ["ops", "data"];
const base = selectBullets(career, { themes });

describe("renderDraftHtml", () => {
  // Mutation this catches: renderBody(career, baseSelection) — the literal
  // reading of "render content through renderBody", which drops every override.
  // A taper override changes which bullets survive, so the two renders differ in
  // their <li> count; without this the checkpoint would be a document the user
  // never had, and nothing else in the suite would notice.
  it("applies a taper override rather than rendering the base selection", () => {
    const withTaper = renderDraftHtml({
      career,
      overlay: [],
      themes,
      baseSelection: base,
      overrides: { selection: { taper: [2, 2, 2, 2, 2] } },
    });
    const naive = renderBody(career, base);
    expect(withTaper).not.toBe(naive);
    const count = (s: string) => (s.match(/<li>/g) || []).length;
    expect(count(withTaper)).toBe(10);
    expect(count(naive)).toBe(16);
  });

  // Mutation this catches: dropping the rootStyle argument. Design tokens ride
  // on the .rsm root; losing them renders an unstyled document that still looks
  // structurally correct, which is exactly the failure that is invisible in a
  // diff of bullet text.
  it("carries design-token overrides onto the root", () => {
    const html = renderDraftHtml({
      career,
      overlay: [],
      themes,
      baseSelection: base,
      overrides: { design: { "--link": "#123456" } },
    });
    expect(html).toContain("#123456");
  });

  // Mutation this catches: passing `merged` rather than `doc.career` to
  // renderBody. compressAfter is applied to the RECORD (rules.compressAfter),
  // not as a render option, so the wrong argument renders every role in full.
  it("honours a compressAfter override", () => {
    const html = renderDraftHtml({
      career,
      overlay: [],
      themes,
      baseSelection: base,
      overrides: { selection: { compressAfter: 2 } },
    });
    expect((html.match(/rsm-role-title/g) || []).length).toBe(2);
  });
});
