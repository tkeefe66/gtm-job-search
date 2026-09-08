// lib/resume-render/render-pipeline.test.ts
//
// The spec's Testing section (docs/superpowers/specs/2026-08-24-resume-builder-design.md,
// revision 4) requires: "given a derived `themes` list (including edge cases —
// empty, containing a theme id not present in content/themes.json),
// selectBullets + renderBody produce non-crashing, non-empty HTML." That
// requirement was never assigned to any of the 5 implementation tasks and had
// no test anywhere in the branch — a gap in the plan, not a miss by any
// implementer.
//
// This is deliberately NOT a test of render.js's own internals — render.js is
// vendored, pure JS this app doesn't own or test directly (see its own header
// comment). It's a defense-in-depth property of the APPLICATION's use of the
// pipeline: app/actions/resume.ts's deriveThemes already filters the model's
// response against the real theme vocabulary before selectBullets ever sees
// it, so this test isn't re-proving that filter — it's proving selectBullets
// and renderBody themselves tolerate an unknown id gracefully, in case that
// filter is ever missing, reordered, or bypassed by some other caller.
import { describe, expect, test } from "vitest";
import { selectBullets, renderBody, type CareerRecord } from "./render";
import career from "./content/resume.json";

describe("the tailoring pipeline (selectBullets + renderBody) never crashes", () => {
  test("an empty themes array produces non-crashing, non-empty HTML", () => {
    const selection = selectBullets(career as CareerRecord, { themes: [] });
    expect(selection).toBeTruthy();

    const html = renderBody(career as CareerRecord, selection);
    expect(typeof html).toBe("string");
    expect(html.length).toBeGreaterThan(0);
  });

  test("a theme id absent from content/themes.json is tolerated, not thrown", () => {
    const selection = selectBullets(career as CareerRecord, { themes: ["not-a-real-theme"] });
    expect(selection).toBeTruthy();

    const html = renderBody(career as CareerRecord, selection);
    expect(typeof html).toBe("string");
    expect(html.length).toBeGreaterThan(0);
  });

  test("a mix of real and unknown theme ids is also tolerated", () => {
    const selection = selectBullets(career as CareerRecord, {
      themes: ["not-a-real-theme", "ops", "also-fake"],
    });
    expect(selection).toBeTruthy();

    const html = renderBody(career as CareerRecord, selection);
    expect(typeof html).toBe("string");
    expect(html.length).toBeGreaterThan(0);
  });
});

import { describe as describe2, it, expect as expect2 } from "vitest";

const ORDERING_FIXTURE = {
  identity: { name: "T", contacts: [] },
  positioning: [{ id: "p", themes: [], tagline: "t", summary: "s" }],
  roles: [
    {
      id: "r1",
      title: "Role One",
      org: "Org",
      dates: "2020 – Present",
      bullets: [
        { id: "b1", priority: 1, themes: [], text: "anchor, off-theme" },
        { id: "b2", priority: 2, themes: ["other"], text: "middle" },
        { id: "b3", priority: 3, themes: ["systems"], text: "on-theme" },
        { id: "b6", priority: 6, themes: ["systems"], tail: true, text: "award" },
      ],
    },
  ],
  advisory: [],
  education: [],
  rules: { taper: [4], themes: ["systems", "other"], compressAfter: null },
} as unknown as CareerRecord;

describe2("selectBullets ordering", () => {
  it("leads with the on-theme bullet, keeps the anchor, and sinks tail bullets", () => {
    const sel = selectBullets(ORDERING_FIXTURE, { themes: ["systems"] });
    expect2(sel.bullets.r1[0]).toBe("b3");
    expect2(sel.bullets.r1).toContain("b1");
    expect2(sel.bullets.r1[sel.bullets.r1.length - 1]).toBe("b6");
  });

  it("orders tail bullets among themselves by priority, after every non-tail bullet", () => {
    const twoTails = JSON.parse(JSON.stringify(ORDERING_FIXTURE));
    twoTails.roles[0].bullets.push({ id: "b5", priority: 5, themes: ["systems"], tail: true, text: "award 2" });
    twoTails.rules.taper = [5];
    const sel = selectBullets(twoTails, { themes: ["systems"] });
    const ids = sel.bullets.r1;
    expect2(ids.slice(-2)).toEqual(["b5", "b6"]);
  });
});
