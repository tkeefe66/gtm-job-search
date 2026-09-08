import { describe, it, expect } from "vitest";
import { effectiveCareer } from "@/lib/effective-career";
import { selectBullets } from "@/lib/resume-render/render";
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

// Only for the duplicate-slot test below — a role with a second, non-anchor
// bullet, so an id collision that ISN'T on the anchor can be simulated too.
const SHIPPED_TWO_BULLETS = {
  ...SHIPPED,
  roles: [
    {
      id: "r1",
      title: "R1",
      org: "Org",
      dates: "2020 – Present",
      bullets: [
        { id: "b1", priority: 1, themes: [], text: "shipped anchor bullet" },
        { id: "b2", priority: 2, themes: [], text: "shipped second bullet" },
      ],
    },
  ],
} as unknown as CareerRecord;

// Only for the cross-role id test below — a second role whose own bullet id
// ("b2") is unrelated, so the collision check must not confuse "same id
// anywhere in the record" with "same id in the role the overlay targets".
const SHIPPED_TWO_ROLES = {
  ...SHIPPED,
  roles: [
    SHIPPED.roles[0],
    {
      id: "r2",
      title: "R2",
      org: "Org2",
      dates: "2018 – 2020",
      bullets: [{ id: "b2", priority: 1, themes: ["ops"], text: "other role's bullet" }],
    },
  ],
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

  it("drops an overlay bullet whose id collides with a record bullet in the same role, and warns", () => {
    const { career, warnings } = effectiveCareer(SHIPPED, [
      { id: "b1", roleId: "r1", text: "colliding overlay text", themes: [] },
    ], {});
    // The collider was dropped, not appended: count and content are unchanged
    // from the shipped role, not silently duplicated-but-unreachable.
    expect(career.roles[0].bullets).toHaveLength(1);
    expect(career.roles[0].bullets[0].text).toBe("shipped bullet");
    expect(warnings.join(" ")).toContain("b1");
  });

  it("keeps the priority-1 anchor selectable when a colliding overlay bullet targets its id", () => {
    // Named by the review finding as "the compounding case": selectBullets'
    // anchor pool-exclusion filter (role.bullets.filter(b => b.id !==
    // anchor.id)) strips every bullet sharing the anchor's id, not just the
    // anchor object. Dropping the collider before it ever reaches the record
    // means the anchor is never at risk of that filter misfiring.
    const { career } = effectiveCareer(SHIPPED, [
      { id: "b1", roleId: "r1", text: "colliding overlay text", themes: [] },
    ], {});
    const selection = selectBullets(career);
    expect(selection.bullets.r1).toContain("b1");
  });

  it("prevents a non-anchor id collision from rendering the same bullet twice in one role", () => {
    // The sharper version of the compounding case, verified by hand-tracing
    // selectBullets against render.js: an anchor-id collision is self-healing
    // (the anchor is unconditionally re-added regardless of pool exclusion),
    // but a collision on a NON-anchor bullet is not — pool exclusion only
    // strips entries matching the ANCHOR's id, so an undropped overlay
    // duplicate of "b2" would sit in the pool alongside the real "b2" and
    // both could be selected, producing ["b1","b2","b2"] — a duplicate id
    // that renderBody's role.bullets.filter(b => b.id === id)[0] resolves to
    // the same original bullet twice, wasting a bullet slot on a repeated
    // line instead of dropping it. Dropping the collider up front removes the
    // duplicate id before selectBullets ever sees it.
    const { career } = effectiveCareer(SHIPPED_TWO_BULLETS, [
      { id: "b2", roleId: "r1", text: "colliding overlay text", themes: [] },
    ], {});
    const selection = selectBullets(career);
    expect(selection.bullets.r1).toEqual(["b1", "b2"]);
    expect(new Set(selection.bullets.r1).size).toBe(selection.bullets.r1.length);
  });

  // N2 (this fix wave's own regression, newly REACHABLE rather than newly
  // written): set_text requires its target to be in the current selection,
  // and an accepted overlay bullet was never in one until acceptProposedBullets
  // started placing what it accepts. The edit was durable in the row and
  // invisible after a reload, with no warning either — the target exists, so
  // "refers to a bullet that no longer exists" never fired.
  it("applies a text override to an OVERLAY bullet, not only to a record bullet", () => {
    const overlay = [{ id: "ov-1", roleId: "r1", text: "Original overlay line.", themes: [] }];
    const { career, warnings } = effectiveCareer(SHIPPED, overlay, {
      "bullet:r1:ov-1": "Edited overlay line.",
    });
    const bullet = career.roles[0].bullets.filter((b) => b.id === "ov-1")[0];
    expect(bullet.text).toBe("Edited overlay line.");
    expect(bullet.edited).toBe(true);
    expect(bullet.origin).toBe("overlay");
    expect(warnings).toEqual([]);
  });

  it("sanitizes an overlay bullet's text override at this boundary too", () => {
    const overlay = [{ id: "ov-1", roleId: "r1", text: "Original overlay line.", themes: [] }];
    const { career } = effectiveCareer(SHIPPED, overlay, {
      "bullet:r1:ov-1": "<img src=x onerror=alert(1)>ok",
    });
    const bullet = career.roles[0].bullets.filter((b) => b.id === "ov-1")[0];
    expect(bullet.text).not.toContain("<img");
  });

  // N3: `taper` is user-settable through the chat now, so an edit reaching
  // for .push() on what looks like a fresh record must not reach the
  // process-wide content/resume.json import.
  it("clones rules deeply enough that its arrays are not the shipped record's", () => {
    const { career } = effectiveCareer(SHIPPED, [], {});
    career.rules.taper.push(99);
    career.rules.themes.push("invented");
    expect(SHIPPED.rules.taper).toEqual([4]);
    expect(SHIPPED.rules.themes).toEqual(["ops", "systems"]);
  });

  it("does not treat an overlay id colliding with a bullet in a DIFFERENT role as a collision", () => {
    const { career, warnings } = effectiveCareer(SHIPPED_TWO_ROLES, [
      { id: "b1", roleId: "r2", text: "same id as r1's bullet, but targets r2", themes: [] },
    ], {});
    expect(career.roles[1].bullets.map((b) => b.id)).toEqual(["b2", "b1"]);
    expect(warnings).toHaveLength(0);
  });
});
