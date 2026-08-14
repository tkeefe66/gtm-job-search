import { describe, expect, test } from "vitest";
import { SCORED_JOBS_SQL, SCORING_INPUT_COLUMNS } from "./rescore-scope";

describe("SCORED_JOBS_SQL", () => {
  test("selects on `is not null`, never on the builder's `<>` rendering", () => {
    // `.neq("fit_score", null)` renders `"fit_score" <> $1` with $1 = null,
    // which is never true in Postgres: zero rows, no error, "rescored 0 of 0"
    // reported as success. This is why rescoreAll uses rawQuery at all.
    expect(SCORED_JOBS_SQL).toContain("where fit_score is not null");
    expect(SCORED_JOBS_SQL).not.toContain("<>");
    expect(SCORED_JOBS_SQL).not.toContain("!=");
  });

  test("selects the id it needs to write back", () => {
    expect(SCORED_JOBS_SQL).toMatch(/\bid\b/);
  });

  test("selects every column scoreFit reads", () => {
    // Dropping any of these does not merely fail to improve a score — it
    // ACTIVELY DEGRADES it. A role scored 4 on "$380M+ ARR, PE exit planned"
    // gets rescored blind and drops, because scoreFit renders the missing
    // field as "unknown" rather than failing.
    expect(SCORING_INPUT_COLUMNS.length).toBeGreaterThan(0);
    for (const col of SCORING_INPUT_COLUMNS) {
      expect(SCORED_JOBS_SQL).toMatch(new RegExp(`\\b${col}\\b`));
    }
  });

  test("the financial signals scoreFit weights explicitly are all present", () => {
    // Named individually rather than left to the loop above: these four are
    // the ones a "trim the select list" edit reaches for first, and the
    // FINANCIAL SIGNALS block in parse-role.ts scores on every one of them.
    for (const col of ["company_description", "arr", "exit_signal", "backer"]) {
      expect(SCORING_INPUT_COLUMNS).toContain(col);
    }
  });

  test("reads fit_summary — it is a prompt INPUT, not a rescore output", () => {
    // fit_summary renders as `Summary: ${opts.fit_summary}` in the prompt, so
    // dropping it from the select rescores against a blank posting summary.
    // (That it is never written BACK is a property of rescoreAll's updateJob
    // call, not of this query — enforced there by comment and review.)
    expect(SCORING_INPUT_COLUMNS).toContain("fit_summary");
    expect(SCORED_JOBS_SQL).toContain("fit_summary");
  });

  test("reads from jobs only", () => {
    expect(SCORED_JOBS_SQL).toContain("from jobs");
    expect(SCORED_JOBS_SQL).not.toContain("join");
  });
});
