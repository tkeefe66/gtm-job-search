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

  // I2: `applied` counts OPERATIONS, not changes. A caller that re-renders on
  // it discards the user's unsaved hand edits for a turn that changed nothing.
  it("reports changedDocument false for operations that change no document", () => {
    const rule = run([{ op: "request_rule_change", description: "two-column header" }]);
    expect(rule.applied!.length).toBe(1);
    expect(rule.changedDocument).toBe(false);

    const proposal = run([
      { op: "propose_career_bullet", roleId: "principal", text: "Did a thing", themes: ["systems"] },
    ]);
    expect(proposal.applied!.length).toBe(1);
    expect(proposal.changedDocument).toBe(false);

    expect(run([]).changedDocument).toBe(false);
    expect(run([{ op: "add_bullet", roleId: "principal", bulletId: "voc" }]).changedDocument).toBe(true);
    // Mixed: one operation that changes the document is enough.
    expect(
      run([
        { op: "request_rule_change", description: "two-column header" },
        { op: "add_bullet", roleId: "principal", bulletId: "voc" },
      ]).changedDocument
    ).toBe(true);
  });

  // C1b: render.js honours opts.lead at role index 0 alone, and
  // lib/effective-document.ts reorders that one role. A lead named on any
  // other role would validate, bill and report success while changing
  // nothing — the class of dishonesty the wiring pass exists to end.
  it("refuses a lead bullet on any role but the most recent", () => {
    const res = run([{ op: "set_lead", roleId: "principal", bulletId: "voc" }]);
    expect(res.error).toContain(CAREER.roles[0].id);
    const ok = run([{ op: "set_lead", roleId: CAREER.roles[0].id, bulletId: CAREER.roles[0].bullets[2].id }]);
    expect(ok.error).toBeUndefined();
    expect(ok.overrides!.selection!.lead).toBe(CAREER.roles[0].bullets[2].id);
  });

  it("namespaces a proposed career bullet id", () => {
    const res = run([{ op: "propose_career_bullet", roleId: "principal", text: "Did a thing", themes: ["systems"] }]);
    expect(res.overlayAdds![0].id.indexOf("ov-")).toBe(0);
  });

  it("rejects an unknown operation name", () => {
    expect(run([{ op: "delete_everything" }]).error).toContain("delete_everything");
  });

  // FINDING 1 (fix round 1): selection.bullets is a plain object literal
  // (render.js:40), so indexing it with an Object.prototype member name
  // resolves the INHERITED value (truthy) instead of undefined, defeating
  // `|| []` and throwing when `.indexOf` is called on a non-array. Every one
  // of these must come back as a clean `{ error }`, not a thrown exception —
  // and specifically the "not on the page" reason, since none of these
  // names is ever an own key of selection.bullets.
  it("rejects a set_text target whose role segment is an inherited Object.prototype name, without throwing", () => {
    ["__proto__", "constructor", "toString", "hasOwnProperty"].forEach((name) => {
      let res: ReturnType<typeof run> | undefined;
      expect(() => {
        res = run([{ op: "set_text", target: "bullet:" + name + ":x", text: "y" }]);
      }).not.toThrow();
      expect(res!.error).toContain("not on the page");
    });
  });

  // A literal `null` element in `operations` must not throw on `op.op`.
  // (A string/number/array element already degraded cleanly before this
  // fix — only `null` reached the crash.)
  it("rejects a null operation without throwing", () => {
    let res: ReturnType<typeof applyOperations> | undefined;
    expect(() => {
      res = applyOperations([null] as unknown as Parameters<typeof applyOperations>[0], CAREER, SELECTION, {}, VOCAB);
    }).not.toThrow();
    expect(res!.error).toBeDefined();
  });

  // FINDING 2 (fix round 1): the same Object.prototype confusion in
  // lib/resume-design-tokens.ts's SPEC_BY_NAME let these three names sail
  // past the "is not adjustable" allowlist check and get written into
  // overrides.design. Confirm the whole turn is rejected atomically instead.
  it("rejects design token names that only resolve via Object.prototype inheritance", () => {
    ["constructor", "toString", "hasOwnProperty"].forEach((name) => {
      const res = run([{ op: "set_design_token", name, value: "black" }]);
      expect(res.error).toContain("not adjustable");
      expect(res.overrides).toBeUndefined();
    });
  });

  // FINDING 3 (fix round 1): outId === inId used to filter the bullet out
  // and push it back on, silently moving it to the end of the role's list —
  // list order is render order. It must now be a genuine no-op.
  it("makes swap_bullet a no-op, not a silent reorder, when outId equals inId", () => {
    const roleId = "principal";
    const before = SELECTION.bullets[roleId];
    const bulletId = before[0];
    const res = run([{ op: "swap_bullet", roleId, outId: bulletId, inId: bulletId }]);
    expect(res.error).toBeUndefined();
    // No selection.bullets override was written for this role at all — the
    // list before the swap is exactly the list after it, and nothing
    // needed to change to prove that.
    expect(res.overrides!.selection?.bullets?.[roleId]).toBeUndefined();
  });
});
