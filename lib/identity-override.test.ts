import { describe, expect, it } from "vitest";
import { effectiveCareer } from "@/lib/effective-career";
import { withoutRepeatedMarker } from "@/lib/restore-marker";
import type { CareerRecord } from "@/lib/resume-render/render";

function record(): CareerRecord {
  return {
    identity: { name: "Tom Keefe", contacts: [{ label: "Denver, CO" }] },
    positioning: [{ id: "gtm", themes: [], tagline: "t", summary: "s" }],
    roles: [
      {
        id: "r1",
        title: "Director",
        org: "Acme",
        dates: "2020 – Present",
        bullets: [{ id: "b1", priority: 1, themes: ["ops"], text: "Did a thing." }],
      },
    ],
    advisory: [],
    education: [],
    rules: { taper: [3], themes: [], compressAfter: null },
  };
}

describe("name override", () => {
  it("renames the header", () => {
    const { career } = effectiveCareer(record(), [], { name: "Thomas Keefe" });
    expect(career.identity.name).toBe("Thomas Keefe");
  });

  // Mutation this catches: assigning career.identity.name without cloning
  // identity first. `...shipped` is a SHALLOW spread, so identity is the SAME
  // object as the module-level content/resume.json import — an override would
  // rename the candidate in every later request for the life of the process,
  // across tenants, and nothing on the page would look wrong until the second
  // request. This is the hazard effectiveCareer already clones `rules` to
  // avoid, one field over.
  it("leaves the shipped record untouched", () => {
    const shipped = record();
    effectiveCareer(shipped, [], { name: "Thomas Keefe" });
    expect(shipped.identity.name).toBe("Tom Keefe");
  });

  // Mutation this catches: sharing the contacts ARRAY between the shipped
  // record and the effective one. Nothing edits contacts today, which is
  // exactly why a future edit would find a booby-trapped reference.
  it("does not share the contacts array with the shipped record", () => {
    const shipped = record();
    const { career } = effectiveCareer(shipped, [], { name: "Thomas Keefe" });
    expect(career.identity.contacts).not.toBe(shipped.identity.contacts);
  });

  // NOT a mutation test, and labelled so nobody mistakes it for one: a blank
  // override is refused by sanitizeBulletText itself ("That text is empty."),
  // so `cleaned` returns null and this holds under every implementation that
  // routes through it. It pins the BEHAVIOUR — a résumé must never render with
  // no name — while the guarantee lives one layer down. An earlier version of
  // effectiveCareer carried its own `!== ""` check here; a mutation of that
  // check survived the suite, which is how the branch was found to be
  // unreachable, and it was deleted rather than left untestable.
  it("keeps the shipped name when the override is blank", () => {
    const { career } = effectiveCareer(record(), [], { name: "   " });
    expect(career.identity.name).toBe("Tom Keefe");
  });
});

describe("withoutRepeatedMarker", () => {
  const marker = "Restored the version saved on Sep 8, 2026.";

  // Mutation this catches: appending unconditionally. Three restores in a row
  // produced three identical marker turns in a real thread, which reads as a
  // broken chat and pushes the actual conversation off screen.
  it("replaces a trailing identical marker rather than stacking", () => {
    const prior = [
      { role: "user", text: "cut to three bullets" },
      { role: "assistant", text: marker },
    ];
    expect(withoutRepeatedMarker(prior, marker)).toHaveLength(1);
  });

  // Mutation this catches: dropping the last message whatever it says. A real
  // assistant turn before a restore is conversation the user needs — only an
  // identical marker is redundant.
  it("keeps a trailing assistant turn that is not the same marker", () => {
    const prior = [{ role: "assistant", text: "Done — every role is trimmed to three bullets." }];
    expect(withoutRepeatedMarker(prior, marker)).toHaveLength(1);
  });

  // Mutation this catches: comparing loosely enough that two DIFFERENT restore
  // markers collapse. Restoring version A then version B is two facts, and the
  // model needs both.
  it("keeps a marker for a different version", () => {
    const prior = [{ role: "assistant", text: "Restored the version saved on Sep 1, 2026." }];
    expect(withoutRepeatedMarker(prior, marker)).toHaveLength(1);
  });

  // Mutation this catches: reaching into an empty array and throwing on a
  // thread whose first event is a restore.
  it("handles an empty thread", () => {
    expect(withoutRepeatedMarker([], marker)).toHaveLength(0);
  });

  // Mutation this catches: assuming every stored message is well-formed. The
  // column is jsonb; a malformed row must not crash the restore.
  it("survives a malformed stored message", () => {
    expect(withoutRepeatedMarker([null, "nope", { role: "assistant" }], marker)).toHaveLength(3);
  });
});
