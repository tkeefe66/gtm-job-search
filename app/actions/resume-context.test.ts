import { describe, it, expect, vi } from "vitest";
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

// Fix-round finding 5: loadResumeContext used to compute both `selection` and
// `coverage` from the UNMERGED stored.selection, so a page reload after a
// chat turn's add_bullet/drop_bullet/swap_bullet/set_positioning showed the
// stale document — reverting on refresh until the next chat turn or a
// Regenerate. Pinned here with a real DB-shaped mock rather than as a pure
// composition test, since the defect was specifically in loadResumeContext's
// own wiring, not in effectiveSelection or coverageReport individually.
describe("loadResumeContext merges a stored bullet-level override into the returned selection", () => {
  it("reflects an add_bullet override on reload, not the stale base", async () => {
    vi.resetModules();
    vi.doMock("@/lib/require-actor", () => ({
      requireActor: async () => ({ userId: "u1", tenantId: "u1", email: "a@b.com", isAdmin: true }),
    }));
    vi.doMock("@/lib/supabase", () => ({
      supabase: {
        forTenant: () => ({
          from: (table: string) => {
            const b: Record<string, unknown> = {};
            b.select = () => b;
            b.eq = () => b;
            b.maybeSingle = () => {
              if (table === "tailored_resumes") {
                return Promise.resolve({
                  data: {
                    content: {
                      themes: ["systems"],
                      // The base selection this job was tailored with — one
                      // bullet on gtm-experts.
                      selection: { positioningId: null, bullets: { "gtm-experts": ["team"] } },
                      // A chat turn's add_bullet, already saved.
                      overrides: { selection: { bullets: { "gtm-experts": ["team", "dse"] } } },
                    },
                  },
                  error: null,
                });
              }
              return Promise.resolve({ data: null, error: null });
            };
            return b;
          },
        }),
      },
      rawQuery: async () => ({ data: [], error: null }),
    }));

    const { loadResumeContext } = await import("./resume");
    const res = await loadResumeContext("11111111-1111-1111-1111-111111111111");

    expect(res.error).toBeUndefined();
    // The stale base (["team"]) would fail this; the merged override is what
    // must come back.
    expect(res.selection?.bullets["gtm-experts"]).toEqual(["team", "dse"]);
    expect(res.coverage).not.toBeNull();

    vi.doUnmock("@/lib/require-actor");
    vi.doUnmock("@/lib/supabase");
  });
});
