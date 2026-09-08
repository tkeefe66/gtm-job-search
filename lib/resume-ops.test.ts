import { describe, it, expect } from "vitest";
import { applyOperations } from "@/lib/resume-ops";
import { selectBullets } from "@/lib/resume-render/render";
import career from "@/lib/resume-render/content/resume.json";
import vocabulary from "@/lib/resume-render/content/themes.json";
import type { CareerRecord, ThemeVocabulary } from "@/lib/resume-render/render";

const CAREER = career as CareerRecord;
const VOCAB = vocabulary as ThemeVocabulary;
const SELECTION = selectBullets(CAREER, { themes: ["systems"] });
const run = (ops: { op: string; [k: string]: unknown }[]) =>
  applyOperations(ops, CAREER, SELECTION, {}, VOCAB);

describe("applyOperations", () => {
  it("applies set_themes", () => {
    const res = run([{ op: "set_themes", themes: ["systems", "data"] }]);
    expect(res.themes).toEqual(["systems", "data"]);
    expect(res.error).toBeUndefined();
  });

  it("rejects a theme outside the vocabulary", () => {
    expect(run([{ op: "set_themes", themes: ["nonsense"] }]).error).toContain("nonsense");
  });

  it("rejects a bullet id outside the role's pool", () => {
    expect(run([{ op: "add_bullet", roleId: "principal", bulletId: "b-nope" }]).error).toContain("b-nope");
  });

  it("rejects a design token outside the allowlist", () => {
    expect(run([{ op: "set_design_token", name: "--page-width", value: "9in" }]).error).toBeDefined();
  });

  it("rejects a malformed token value", () => {
    expect(run([{ op: "set_design_token", name: "--rail", value: "1px } .rsm {" }]).error).toBeDefined();
  });

  it("rejects a text target not in the current selection", () => {
    const bullets = SELECTION.bullets["principal"];
    const notSelected = CAREER.roles
      .filter((r) => r.id === "principal")[0]
      .bullets.filter((b) => bullets.indexOf(b.id) === -1)[0];
    expect(run([{ op: "set_text", target: "bullet:principal:" + notSelected.id, text: "x" }]).error)
      .toContain("not on the page");
  });

  it("sanitizes accepted text", () => {
    const target = "bullet:principal:" + SELECTION.bullets["principal"][0];
    const res = run([{ op: "set_text", target, text: "<img src=x onerror=alert(1)>ok" }]);
    expect(res.overrides!.text![target]).not.toContain("<img");
  });

  // A turn is ATOMIC: a partially applied turn leaves the document, the
  // coverage panel and the persisted thread describing a state nobody asked for.
  it("applies nothing when any operation in the turn is invalid", () => {
    const res = run([
      { op: "set_themes", themes: ["systems"] },
      { op: "add_bullet", roleId: "principal", bulletId: "b-nope" },
    ]);
    expect(res.error).toBeDefined();
    expect(res.themes).toBeUndefined();
    expect(res.overrides).toBeUndefined();
  });

  it("collects a rule-change request without touching the document", () => {
    const res = run([{ op: "request_rule_change", description: "two-column header" }]);
    expect(res.ruleRequests).toEqual(["two-column header"]);
    expect(res.overrides).toEqual({});
  });

  it("namespaces a proposed career bullet id", () => {
    const res = run([{ op: "propose_career_bullet", roleId: "principal", text: "Did a thing", themes: ["systems"] }]);
    expect(res.overlayAdds![0].id.indexOf("ov-")).toBe(0);
  });

  it("rejects an unknown operation name", () => {
    expect(run([{ op: "delete_everything" }]).error).toContain("delete_everything");
  });
});
