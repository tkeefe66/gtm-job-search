// lib/effective-document.test.ts
//
// Every assertion here is about the RENDERED DOCUMENT (or the coverage report
// the panel shows), never about the override object. That is the whole point:
// the final pre-merge review found five operations validated, billed,
// persisted and reported as applied while changing nothing, and per-task
// review missed all five because Task 10's tests asserted the override and
// Task 12's asserted persistence. No test owned the hop from override to
// pixel. These do.
import { describe, expect, test } from "vitest";
import { effectiveDocument } from "@/lib/effective-document";
import { coverageReport } from "@/lib/resume-coverage";
import { renderBody, selectBullets } from "@/lib/resume-render/render";
import career from "@/lib/resume-render/content/resume.json";
import vocabulary from "@/lib/resume-render/content/themes.json";
import type { CareerRecord, ThemeVocabulary } from "@/lib/resume-render/render";

const RECORD = career as CareerRecord;
const VOCAB = vocabulary as ThemeVocabulary;
const THEMES = ["systems", "data", "ops"];

function base() {
  return selectBullets(RECORD, { themes: THEMES });
}

function render(over: Parameters<typeof effectiveDocument>[3]) {
  const doc = effectiveDocument(RECORD, base(), THEMES, over);
  return { html: renderBody(doc.career, doc.selection), doc };
}

function countLi(html: string): number {
  return html.split("<li>").length - 1;
}

function firstBulletText(html: string): string {
  const i = html.indexOf("<li>");
  return html.slice(i + 4, html.indexOf("</li>", i));
}

describe("C1a set_taper reaches the document", () => {
  test("a tighter taper renders strictly fewer bullets", () => {
    const before = render({});
    const after = render({ selection: { taper: [3, 2, 2, 1, 1] } });
    expect(countLi(after.html)).toBeLessThan(countLi(before.html));
    // Not merely fewer — the cap is what decides how many.
    expect(after.doc.selection.bullets["gtm-experts"].length).toBe(3);
    expect(after.doc.selection.bullets["principal"].length).toBe(2);
  });

  test("a per-role bullet edit outranks the taper for that role only", () => {
    const after = render({
      selection: { taper: [3, 2, 2, 1, 1], bullets: { "gtm-experts": ["team", "dse", "dse-scale", "playbook"] } },
    });
    expect(after.doc.selection.bullets["gtm-experts"].length).toBe(4);
    expect(after.doc.selection.bullets["principal"].length).toBe(2);
  });
});

describe("C1b set_lead reaches the document", () => {
  test("the lead bullet renders first, and the bullet count does not grow", () => {
    const before = render({});
    const led = RECORD.roles[0].bullets.filter((b) => b.id === "playbook")[0];
    const after = render({ selection: { lead: "playbook" } });
    expect(after.doc.selection.bullets["gtm-experts"][0]).toBe("playbook");
    expect(firstBulletText(after.html)).toBe(led.text);
    expect(countLi(after.html)).toBe(countLi(before.html));
  });

  test("a lead survives a per-role bullet override on the same role", () => {
    // Through selectBullets' own opts.lead this would be silently discarded:
    // the override replaces that role's list wholesale afterwards.
    const after = render({
      selection: { lead: "playbook", bullets: { "gtm-experts": ["team", "dse"] } },
    });
    expect(after.doc.selection.bullets["gtm-experts"]).toEqual(["playbook", "team"]);
  });
});

describe("C1c set_compress_after reaches the document AND the coverage panel", () => {
  test("compressing earlier renders fewer role blocks and more one-line rows", () => {
    const before = render({});
    const after = render({ selection: { compressAfter: 2 } });
    const roleBlocks = (h: string) => h.split('<div class="rsm-role">').length - 1;
    expect(roleBlocks(after.html)).toBeLessThan(roleBlocks(before.html));
    expect(roleBlocks(after.html)).toBe(2);
    expect(countLi(after.html)).toBeLessThan(countLi(before.html));
  });

  test("the coverage report's own denominator moves with it", () => {
    const wide = effectiveDocument(RECORD, base(), THEMES, {});
    const tight = effectiveDocument(RECORD, base(), THEMES, { selection: { compressAfter: 2 } });
    const a = coverageReport(wide.career, THEMES, wide.selection, VOCAB);
    const b = coverageReport(tight.career, THEMES, tight.selection, VOCAB);
    expect(b.themes[0].pool).toBeLessThan(a.themes[0].pool);
  });

  test("the shipped record is never mutated — rules is cloned, arrays included", () => {
    const original = RECORD.rules.compressAfter;
    const taper = RECORD.rules.taper.slice();
    const doc = effectiveDocument(RECORD, base(), THEMES, { selection: { compressAfter: 1 } });
    expect(RECORD.rules.compressAfter).toBe(original);
    // N3: a shallow spread leaves rules.taper pointing at the process-wide
    // import, and taper is user-settable through the chat.
    doc.career.rules.taper.push(99);
    doc.career.rules.themes.push("invented");
    expect(RECORD.rules.taper).toEqual(taper);
  });
});

describe("C1d new themes re-select the bullets they claim to drive", () => {
  test("a base derived from different themes renders different bullets", () => {
    // What sendChatTurn now persists on a set_themes turn: a base re-derived
    // from the new themes. Before, the row kept the OLD selection beside the
    // new themes and the coverage panel described a document that did not
    // exist — permanently, on every later load.
    const other = ["leadership", "evangelism", "migration"];
    const rebased = effectiveDocument(RECORD, selectBullets(RECORD, { themes: other }), other, {});
    const original = effectiveDocument(RECORD, base(), THEMES, {});
    expect(rebased.selection.bullets).not.toEqual(original.selection.bullets);
    expect(renderBody(rebased.career, rebased.selection)).not.toBe(
      renderBody(original.career, original.selection)
    );
  });
});

describe("I3 a role absent from the stored selection", () => {
  test("is filled from the record, so all three surfaces agree with render.js", () => {
    const stored = base();
    const withoutPrincipal = {
      positioningId: stored.positioningId,
      bullets: Object.keys(stored.bullets)
        .filter((id) => id !== "principal")
        .reduce<Record<string, string[]>>((acc, id) => {
          acc[id] = stored.bullets[id];
          return acc;
        }, {}),
    };
    const doc = effectiveDocument(RECORD, withoutPrincipal, THEMES, {});
    // render.js falls back to the whole pool for an absent role; the ops
    // module and the coverage module fell back to []. Filling here is what
    // makes one drop_bullet remove ONE line instead of six.
    const pool = RECORD.roles.filter((r) => r.id === "principal")[0].bullets.map((b) => b.id);
    expect(doc.selection.bullets["principal"]).toEqual(pool);

    const rendered = countLi(renderBody(doc.career, doc.selection));
    const afterDrop = effectiveDocument(RECORD, withoutPrincipal, THEMES, {
      selection: { bullets: { principal: pool.filter((id) => id !== pool[0]) } },
    });
    expect(countLi(renderBody(afterDrop.career, afterDrop.selection))).toBe(rendered - 1);
  });

  test("an explicit empty override still means the role shows nothing", () => {
    const doc = effectiveDocument(RECORD, base(), THEMES, { selection: { bullets: { principal: [] } } });
    expect(doc.selection.bullets["principal"]).toEqual([]);
  });
});
