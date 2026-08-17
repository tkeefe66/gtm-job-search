import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { DEFAULT_PROFILE } from "./profile";

/**
 * THE PHASE-2 GUARD.
 *
 * Phase 1's post-mortem states the risk this test exists for: "Required
 * parameters buy less than they appear to. They catch OMISSION, which is a
 * phase-1 risk. A phase-2 site that forgets to switch its argument keeps
 * passing CANDIDATE_PERSONA — compiles, type-checks, ships GTM text to a
 * nurse."
 *
 * Two halves, and both are needed. The per-builder tests assert a CHANGED value
 * reaches the rendered prompt; this one asserts no production module can reach
 * a career-specific string at all. A builder test cannot see a call site, and a
 * call site inside a "use server" module cannot be called from a test.
 *
 * Precedent for reading source in a test: lib/job-statuses.test.ts, which walks
 * the tree asserting no Tailwind arbitrary-value class escapes app/ or
 * components/.
 */

const ROOT = path.resolve(__dirname, "..");

/**
 * Where a career-specific string is ALLOWED to appear.
 *
 * `lib/search-criteria.ts` is here for a narrow, coincidental reason, not
 * because it is exempt from the switch: `DEFAULT_FIT_BRAIN` (Tom's own bio,
 * a `Criteria` default — a separate, user-editable system from `Profile`,
 * out of this task's scope per CLAUDE.md) contains the prose "marketing/
 * revenue operations leadership", which happens to contain
 * `profile.querySubject`'s value ("revenue operations") as a substring. That
 * line has been unchanged since before this task (one commit ever touched
 * it) and has nothing to do with the six constants this task deletes. Every
 * function this file still exports (`roleSearchSystem`, `roleExtractionSchema`,
 * `stackQueries`) is fully parameter-driven with no embedded career literal
 * of its own, so this entry does not weaken the guard against the actual
 * risk — a phase-2 CALL SITE keeping a hardcoded string instead of switching
 * to the profile. The deleted-name scan below still covers this file in
 * full: a re-introduced `SEARCH_SUBJECT`-named constant here would still fail
 * it.
 */
const HOMES = new Set([
  "lib/profile.ts",
  "lib/fit-prompt.ts",
  "lib/search-criteria.ts",
  "lib/__fixtures__/fit-golden-set.json",
]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === ".git") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const FILES = [
  ...sourceFiles(path.join(ROOT, "lib")),
  ...sourceFiles(path.join(ROOT, "app")),
  ...sourceFiles(path.join(ROOT, "components")),
].map((f) => ({ rel: path.relative(ROOT, f), text: readFileSync(f, "utf8") }));

describe("no production module holds a career-specific string", () => {
  const PHRASES: [string, string][] = [
    ["searchSubject", DEFAULT_PROFILE.searchSubject],
    ["querySubject", DEFAULT_PROFILE.querySubject],
    ["stackFamilyIntro", DEFAULT_PROFILE.stackFamilyIntro],
    ["candidatePersona", DEFAULT_PROFILE.candidatePersona],
    ["buildingConcept", DEFAULT_PROFILE.buildingConcept],
    ["buildingUpside", DEFAULT_PROFILE.buildingUpside],
    ["weakFitTail", DEFAULT_PROFILE.weakFitTail],
    ["moderateTail", DEFAULT_PROFILE.moderateTail],
    ["strongTail", DEFAULT_PROFILE.strongTail],
  ];

  for (const [field, phrase] of PHRASES) {
    test(`${field}'s text appears only in its home module`, () => {
      const offenders = FILES.filter(
        (f) => !HOMES.has(f.rel) && f.text.includes(phrase)
      ).map((f) => f.rel);
      expect(offenders, `move this text into the profile: ${field}`).toEqual([]);
    });
  }

  test("no module outside lib/profile.ts imports a deleted GTM constant", () => {
    // Names, not text: a re-introduced `SEARCH_SUBJECT` import would pass the
    // phrase checks above (the string lives in profile.ts) while pinning a
    // call site to one career again.
    const GONE = [
      "SEARCH_SUBJECT",
      "QUERY_SUBJECT",
      "STACK_FAMILY_INTRO",
      "CANDIDATE_PERSONA",
      "BUILDING_CONCEPT",
      "BUILDING_UPSIDE",
    ];
    for (const name of GONE) {
      const offenders = FILES.filter((f) =>
        new RegExp(`\\b${name}\\b`).test(f.text)
      ).map((f) => f.rel);
      expect(offenders, `${name} was deleted in phase 2`).toEqual([]);
    }
  });
});
