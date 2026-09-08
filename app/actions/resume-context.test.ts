import { describe, it, expect } from "vitest";
import { selectBullets } from "@/lib/resume-render/render";
import { effectiveCareer } from "@/lib/effective-career";
import { coverageReport } from "@/lib/resume-coverage";
import career from "@/lib/resume-render/content/resume.json";
import vocabulary from "@/lib/resume-render/content/themes.json";
import type { CareerRecord, ThemeVocabulary } from "@/lib/resume-render/render";

// The composition the action performs, asserted without a database: an overlay
// bullet must be visible to SCORING and to COVERAGE, which is exactly what
// breaks when the client renders the shipped record instead.
describe("resume context composition", () => {
  it("scores and counts an overlay bullet", () => {
    const { career: merged } = effectiveCareer(career as CareerRecord, [
      { id: "ov-1", roleId: "gtm-experts", text: "Built a thing", themes: ["systems"], priority: 2 },
    ], {});
    const selection = selectBullets(merged, { themes: ["systems"] });
    expect(selection.bullets["gtm-experts"]).toContain("ov-1");
    const report = coverageReport(merged, ["systems"], selection, vocabulary as ThemeVocabulary);
    expect(report.overlayBullets).toBeGreaterThan(0);
  });
});
