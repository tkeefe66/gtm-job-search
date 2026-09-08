import { describe, it, expect } from "vitest";
import { effectiveCareer } from "@/lib/effective-career";
import type { CareerRecord } from "@/lib/resume-render/render";

const SHIPPED = {
  identity: { name: "T", contacts: [] },
  positioning: [{ id: "pos", themes: [], tagline: "tag", summary: "shipped summary" }],
  roles: [
    { id: "r1", title: "R1", org: "Org", dates: "2020 – Present",
      bullets: [{ id: "b1", priority: 1, themes: ["ops"], text: "shipped bullet" }] },
  ],
  advisory: [], education: [],
  rules: { taper: [4], themes: ["ops", "systems"], compressAfter: null },
} as unknown as CareerRecord;

describe("effectiveCareer", () => {
  it("merges an overlay bullet into its role", () => {
    const { career } = effectiveCareer(SHIPPED, [
      { id: "ov-1", roleId: "r1", text: "overlay bullet", themes: ["systems"] },
    ], {});
    const bullets = career.roles[0].bullets;
    expect(bullets.map((b) => b.id)).toEqual(["b1", "ov-1"]);
    expect((bullets[1] as { origin?: string }).origin).toBe("overlay");
  });

  it("warns rather than silently dropping an overlay for an unknown role", () => {
    const { career, warnings } = effectiveCareer(SHIPPED, [
      { id: "ov-9", roleId: "nope", text: "x", themes: [] },
    ], {});
    expect(career.roles[0].bullets).toHaveLength(1);
    expect(warnings.join(" ")).toContain("nope");
  });

  it("applies a text override by id and marks the bullet edited", () => {
    const { career } = effectiveCareer(SHIPPED, [], { "bullet:r1:b1": "edited text" });
    expect(career.roles[0].bullets[0].text).toBe("edited text");
    expect((career.roles[0].bullets[0] as { edited?: boolean }).edited).toBe(true);
  });

  it("sanitizes a stored text override at merge time", () => {
    const { career } = effectiveCareer(SHIPPED, [], { "bullet:r1:b1": "<img src=x onerror=alert(1)>" });
    expect(career.roles[0].bullets[0].text).not.toContain("<img");
  });

  it("sanitizes overlay text at merge time", () => {
    const { career } = effectiveCareer(SHIPPED, [
      { id: "ov-1", roleId: "r1", text: "<script>alert(1)</script>", themes: [] },
    ], {});
    expect(career.roles[0].bullets[1].text).not.toContain("<script");
  });

  it("overrides the positioning summary", () => {
    const { career } = effectiveCareer(SHIPPED, [], { summary: "new summary" });
    expect(career.positioning[0].summary).toBe("new summary");
  });

  it("returns a fresh record and never mutates the shipped one", () => {
    const before = JSON.stringify(SHIPPED);
    const { career } = effectiveCareer(SHIPPED, [
      { id: "ov-1", roleId: "r1", text: "x", themes: [] },
    ], { "bullet:r1:b1": "y" });
    expect(JSON.stringify(SHIPPED)).toBe(before);
    expect(career).not.toBe(SHIPPED);
    expect(career.roles[0]).not.toBe(SHIPPED.roles[0]);
  });

  it("ignores a text override naming a bullet that does not exist", () => {
    const { warnings } = effectiveCareer(SHIPPED, [], { "bullet:r1:nope": "x" });
    expect(warnings.join(" ")).toContain("nope");
  });
});
