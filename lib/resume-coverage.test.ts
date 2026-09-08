import { describe, it, expect } from "vitest";
import { coverageReport } from "@/lib/resume-coverage";
import { selectBullets } from "@/lib/resume-render/render";
import type { CareerRecord, ThemeVocabulary } from "@/lib/resume-render/render";

const VOCAB = { themes: [
  { id: "systems", label: "Systems", jdSignals: [] },
  { id: "data", label: "Data", jdSignals: [] },
  { id: "absent", label: "Absent", jdSignals: [] },
] } as unknown as ThemeVocabulary;

function role(id: string, themes: string[][]) {
  return {
    id, title: id, org: "Org", dates: "2020 – 2021",
    bullets: themes.map((t, i) => ({ id: id + "-b" + i, priority: i + 1, themes: t, text: "x" })),
  };
}

const CAREER = {
  identity: { name: "T", contacts: [] },
  positioning: [{ id: "p", themes: [], tagline: "t", summary: "s" }],
  // compressAfter 1: only `shown` renders; `hidden` is a compressed one-line row.
  roles: [role("shown", [["systems"], ["systems"], ["data"]]), role("hidden", [["systems"], ["systems"]])],
  advisory: [], education: [],
  rules: { taper: [3, 2], themes: ["systems", "data"], compressAfter: 1 },
} as unknown as CareerRecord;

describe("coverageReport", () => {
  const selection = selectBullets(CAREER, { themes: ["systems", "data", "absent"] });
  const report = coverageReport(CAREER, ["systems", "data", "absent"], selection, VOCAB);

  it("counts only bullets that actually render", () => {
    const systems = report.themes.find((t) => t.theme === "systems")!;
    expect(systems.pool).toBe(2);
    expect(systems.poolBeyondRendered).toBe(2);
    expect(systems.roles).toEqual(["shown"]);
  });

  it("reports a theme with no support as absent and lists it in gaps", () => {
    expect(report.themes.find((t) => t.theme === "absent")!.support).toBe("absent");
    expect(report.gaps).toContain("absent");
  });

  it("verdicts thin below three supporting bullets", () => {
    expect(report.themes.find((t) => t.theme === "data")!.support).toBe("thin");
  });

  it("computes strength over rendered bullets only", () => {
    expect(report.strength).not.toBeNull();
    expect(report.strength!).toBeGreaterThan(0);
    expect(report.strength!).toBeLessThanOrEqual(1);
  });

  it("counts overlay and edited bullets", () => {
    const withMeta = JSON.parse(JSON.stringify(CAREER));
    withMeta.roles[0].bullets[0].origin = "overlay";
    withMeta.roles[0].bullets[1].edited = true;
    const sel = selectBullets(withMeta, { themes: ["systems"] });
    const r = coverageReport(withMeta, ["systems"], sel, VOCAB);
    expect(r.overlayBullets).toBe(1);
    expect(r.editedBullets).toBe(1);
  });
});
