import { describe, expect, test } from "vitest";
import {
  tallyRescoreOutcomes,
  type RescoreOutcome,
  DEFAULT_RESCORE_LIMIT,
  MAX_RESCORE_LIMIT,
  SCORED_JOBS_COUNT_SQL,
  SCORED_JOBS_REMAINING_SQL,
  SCORED_JOBS_SQL,
  SCORING_INPUT_COLUMNS,
  clampRescoreLimit,
  passStartFrom,
  scoringArgsFor,
  type ScoredJobRow,
} from "./rescore-scope";

// Every field distinct and non-empty, so a mapping that transposes two columns
// or substitutes a constant fails rather than coincidentally matching.
const FULL_ROW: ScoredJobRow = {
  id: "row-id",
  company: "Acme",
  role_title: "Head of RevOps",
  company_description: "B2B SaaS for widgets",
  department: "Revenue",
  location: "Denver, CO",
  key_skills: "Salesforce, Marketo",
  fit_summary: "Broad GTM systems ownership",
  salary_range: "$210,000 - $240,000",
  arr: "$380M+ ARR",
  exit_signal: "PE exit planned",
  backer: "Centerbridge Partners",
};

const NULL_ROW: ScoredJobRow = {
  id: "row-id",
  company: "Acme",
  role_title: "Head of RevOps",
  company_description: null,
  department: null,
  location: null,
  key_skills: null,
  fit_summary: null,
  salary_range: null,
  arr: null,
  exit_signal: null,
  backer: null,
};

describe("SCORED_JOBS_SQL", () => {
  test("selects on `is not null`, never on the builder's `<>` rendering", () => {
    // `.neq("fit_score", null)` renders `"fit_score" <> $1` with $1 = null,
    // which is never true in Postgres: zero rows, no error, "rescored 0 of 0"
    // reported as success. This is why rescoreAll uses rawQuery at all.
    expect(SCORED_JOBS_SQL).toContain("where fit_score is not null");
    expect(SCORED_JOBS_SQL).not.toContain("<>");
    expect(SCORED_JOBS_SQL).not.toContain("!=");
  });

  test("all three queries share one definition of 'already scored'", () => {
    // Three hand-written copies of the predicate would eventually disagree,
    // and the count shown to the user would describe a different set from the
    // one rescoreAll actually walks.
    for (const sql of [
      SCORED_JOBS_SQL,
      SCORED_JOBS_COUNT_SQL,
      SCORED_JOBS_REMAINING_SQL,
    ]) {
      expect(sql).toContain("fit_score is not null");
      expect(sql).not.toContain("<>");
    }
  });

  test("is bounded and ordered so a second call makes progress", () => {
    // Bounded: one scoreFit call per row at ~$0.0076 and a couple of seconds;
    // an unbounded pass over a few hundred rows outruns the request timeout
    // and loses its own return value.
    expect(SCORED_JOBS_SQL).toContain("limit $1");
    // Ordered: rescoring does not shrink the `fit_score is not null` set, so
    // without oldest-first ordering every batch would re-score the same rows
    // forever. updateJob stamps updated_at, sending finished rows to the back.
    expect(SCORED_JOBS_SQL).toContain("order by updated_at asc nulls first");
  });

  test("the remaining count is scoped to rows this pass has not touched", () => {
    // Not a plain total: after a batch lands, the finished rows still satisfy
    // `fit_score is not null`, so an unscoped count would never decrease and
    // the caller would loop forever.
    expect(SCORED_JOBS_REMAINING_SQL).toContain("updated_at < $1");
    expect(SCORED_JOBS_REMAINING_SQL).toContain("updated_at is null");
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

  test("reads salary_range — a rescore without it scores blind on pay", () => {
    // The whole point of the compensation task: scoreFit renders the posting's
    // pay and compares it to the user's floor. Drop this column and every
    // rescore recomputes the score as if the employer published nothing,
    // silently undoing the feature for every row it touches — while the
    // rescore reports success.
    expect(SCORING_INPUT_COLUMNS).toContain("salary_range");
    expect(SCORED_JOBS_SQL).toContain("salary_range");
  });

  test("reads from jobs only", () => {
    expect(SCORED_JOBS_SQL).toContain("from jobs");
    expect(SCORED_JOBS_SQL).not.toContain("join");
  });
});

describe("scoringArgsFor", () => {
  test("forwards every column the query selects, with its value intact", () => {
    // THE point of this extraction. arr / exit_signal / backer are OPTIONAL on
    // scoreFit's opts, so deleting those three lines from an inline object
    // literal in the action compiles clean and passes every other test — while
    // silently rescoring blind and dropping a 4 to a 2. Checking presence AND
    // value also catches a transposition (arr: row.backer), which a
    // key-presence check alone would wave through.
    const args = scoringArgsFor(FULL_ROW) as unknown as Record<string, unknown>;
    expect(SCORING_INPUT_COLUMNS.length).toBeGreaterThan(0);
    for (const col of SCORING_INPUT_COLUMNS) {
      expect(Object.keys(args)).toContain(col);
      expect(args[col]).toBe((FULL_ROW as unknown as Record<string, unknown>)[col]);
    }
  });

  test("forwards nothing beyond the stated contract", () => {
    // `id` is the write key, not a scoring input; leaking it into the prompt
    // would spend tokens on a uuid the model cannot use.
    const keys = Object.keys(scoringArgsFor(FULL_ROW));
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.sort()).toEqual([...SCORING_INPUT_COLUMNS].sort());
  });

  test("nulls become empty strings, never the literal text 'null'", () => {
    // These interpolate straight into the prompt. `Company description: null`
    // is a sentence the model will reason about.
    const args = scoringArgsFor(NULL_ROW);
    expect(args.company_description).toBe("");
    expect(args.department).toBe("");
    expect(args.location).toBe("");
    expect(args.key_skills).toBe("");
    expect(args.fit_summary).toBe("");
    // salary_range is REQUIRED on scoreFit, so it cannot degrade to undefined
    // the way arr/exit_signal/backer do. "" is what the prompt renders as
    // "not listed"; a null would render as the literal word "null", which the
    // model would read as a compensation fact about the posting.
    expect(args.salary_range).toBe("");
  });

  test("null financial signals become undefined, so scoreFit prints 'unknown'", () => {
    // scoreFit renders these as `${opts.arr || "unknown"}`. A null would print
    // as "unknown" too, but undefined is what the optional type states and
    // what keeps the key from appearing as an explicit null in the payload.
    const args = scoringArgsFor(NULL_ROW);
    expect(args.arr).toBeUndefined();
    expect(args.exit_signal).toBeUndefined();
    expect(args.backer).toBeUndefined();
  });
});

describe("passStartFrom", () => {
  const FALLBACK = new Date("2026-08-13T12:00:00.000Z");

  test("with nothing to carry forward, the pass starts now", () => {
    // The first batch of a pass. The server's clock, never the browser's.
    expect(passStartFrom(undefined, FALLBACK)).toBe("2026-08-13T12:00:00.000Z");
  });

  test("carries a supplied pass start through unchanged", () => {
    // THE property the whole fix rests on: batch 2 counts `remaining` against
    // the moment the PASS began, not the moment this batch began. A fresh
    // timestamp here makes batch 1's finished rows look outstanding again, so
    // `remaining` never reaches zero and every extra click buys a full pass.
    expect(passStartFrom("2026-08-13T11:00:00.000Z", FALLBACK)).toBe(
      "2026-08-13T11:00:00.000Z"
    );
  });

  test("normalizes to one format before it reaches the query", () => {
    expect(passStartFrom("2026-08-13T11:00:00Z", FALLBACK)).toBe(
      "2026-08-13T11:00:00.000Z"
    );
  });

  test("an unusable value falls back instead of poisoning the count", () => {
    // The value round-trips through a client. Bound into `updated_at < $1`,
    // "not a date" is an invalid timestamp literal: Postgres errors, the count
    // fails, and countRemaining answers 0 — which silently ENDS the pass.
    expect(passStartFrom("not a date", FALLBACK)).toBe("2026-08-13T12:00:00.000Z");
    expect(passStartFrom("", FALLBACK)).toBe("2026-08-13T12:00:00.000Z");
    expect(passStartFrom(42 as unknown as string, FALLBACK)).toBe(
      "2026-08-13T12:00:00.000Z"
    );
  });

  test("defaults its fallback to the real clock", () => {
    const before = Date.now();
    const t = Date.parse(passStartFrom(undefined));
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(Date.now());
  });
});

describe("clampRescoreLimit", () => {
  test("defaults when no limit is given", () => {
    expect(clampRescoreLimit()).toBe(DEFAULT_RESCORE_LIMIT);
    expect(clampRescoreLimit(null)).toBe(DEFAULT_RESCORE_LIMIT);
    expect(clampRescoreLimit(undefined)).toBe(DEFAULT_RESCORE_LIMIT);
  });

  test("caps at MAX_RESCORE_LIMIT — the bound is the whole point", () => {
    // The limit arrives from a client component. If a caller could pass
    // Infinity the batching would be decorative.
    expect(clampRescoreLimit(1000)).toBe(MAX_RESCORE_LIMIT);
    expect(clampRescoreLimit(Infinity)).toBe(DEFAULT_RESCORE_LIMIT);
    expect(MAX_RESCORE_LIMIT).toBeGreaterThanOrEqual(DEFAULT_RESCORE_LIMIT);
  });

  test("floors at 1 rather than 0 — a batch of zero can never drain", () => {
    expect(clampRescoreLimit(0)).toBe(1);
    expect(clampRescoreLimit(-5)).toBe(1);
  });

  test("passes a usable value through untouched, and truncates fractions", () => {
    expect(clampRescoreLimit(10)).toBe(10);
    expect(clampRescoreLimit(10.9)).toBe(10);
  });

  test("a non-number takes the default instead of poisoning `limit $1`", () => {
    expect(clampRescoreLimit(NaN)).toBe(DEFAULT_RESCORE_LIMIT);
    expect(clampRescoreLimit("25" as unknown as number)).toBe(DEFAULT_RESCORE_LIMIT);
  });
});

describe("tallyRescoreOutcomes", () => {
  test("counts each outcome into its own bucket", () => {
    const t = tallyRescoreOutcomes([
      "rescored", "rescored", "score-failed", "write-failed", "rescored",
    ]);
    expect(t).toEqual({ rescored: 3, scoreFailures: 1, writeFailures: 1 });
  });

  test("a failure is never counted as a rescore", () => {
    // The bug this guards: parallelizing the batch and incrementing shared
    // counters inside the callbacks, so a failed row lands in the wrong bucket
    // or in two. Every outcome must map to exactly one increment.
    const t = tallyRescoreOutcomes(["score-failed", "write-failed"]);
    expect(t.rescored).toBe(0);
    expect(t.scoreFailures + t.writeFailures).toBe(2);
  });

  test("the buckets sum to the number of rows, losing none", () => {
    const outcomes: RescoreOutcome[] = [
      "write-failed", "rescored", "score-failed", "rescored", "score-failed",
    ];
    expect(outcomes.length).toBeGreaterThan(0);
    const t = tallyRescoreOutcomes(outcomes);
    expect(t.rescored + t.scoreFailures + t.writeFailures).toBe(outcomes.length);
  });

  test("an empty batch tallies to zeros rather than throwing", () => {
    expect(tallyRescoreOutcomes([])).toEqual({
      rescored: 0, scoreFailures: 0, writeFailures: 0,
    });
  });
});
