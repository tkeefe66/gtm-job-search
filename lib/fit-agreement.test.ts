import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { agreement, gate, ADVERSARIAL_CASES, type Scored } from "./fit-agreement";

const golden = JSON.parse(
  readFileSync(path.join(__dirname, "__fixtures__", "fit-golden-set.json"), "utf8")
);

const perfect = (): Scored[] =>
  golden.roles.map((r: any) => ({
    company: r.company,
    role_title: r.role_title,
    expected_score: r.expected_score,
    actual_score: r.expected_score,
  }));

describe("the golden set itself", () => {
  test("is large enough to mean something", () => {
    expect(golden.roles.length).toBeGreaterThanOrEqual(25);
  });

  test("records what produced it, or it cannot be reproduced", () => {
    expect(golden.model).toBeTruthy();
    expect(golden.capturedAt).toBeTruthy();
    // The scores depend on these two inputs as much as on the model.
    expect(golden.fitBrain.length).toBeGreaterThan(100);
  });

  test("spans the scale rather than clustering on one value", () => {
    const distinct = new Set(golden.roles.map((r: any) => r.expected_score));
    expect(distinct.size).toBeGreaterThanOrEqual(3);
  });

  // These are the rules most likely to break on a weaker model, so they must be
  // IN the set — a gate that silently lost its adversarial rows would pass.
  test("contains both adversarial cases at their expected scores", () => {
    for (const c of ADVERSARIAL_CASES) {
      const row = golden.roles.find((r: any) => r.company === c.company);
      expect(row, `${c.company} missing from the golden set`).toBeTruthy();
      expect(row.expected_score, c.rule).toBe(c.expected);
    }
  });
});

describe("agreement", () => {
  test("identical scores agree perfectly", () => {
    const a = agreement(perfect());
    expect(a.exactMatch).toBe(1);
    expect(a.meanAbsoluteDeviation).toBe(0);
  });

  // An empty run has agreed about NOTHING. Reporting 100% would let a harness
  // that failed to run at all sail through the gate.
  test("an empty comparison reports zero agreement, not perfect", () => {
    expect(agreement([]).exactMatch).toBe(0);
    expect(gate([]).pass).toBe(false);
  });

  test("reports the worst single disagreement", () => {
    const rows = perfect();
    rows[0].actual_score = Math.min(5, rows[0].expected_score + 2);
    expect(agreement(rows).worst?.company).toBe(rows[0].company);
  });
});

describe("gate", () => {
  test("a provider matching the golden set ships", () => {
    expect(gate(perfect()).pass).toBe(true);
  });

  // Loose on the aggregate BY DESIGN: a uniformly harsher model shifts the whole
  // table together and stays usable.
  test("a small number of one-point differences still passes", () => {
    const rows = perfect();
    for (let i = 0; i < 5; i++) rows[i].actual_score = Math.max(1, rows[i].expected_score - 1);
    expect(gate(rows).pass).toBe(true);
  });

  test("broad disagreement fails on the aggregate", () => {
    const rows = perfect().map((r) => ({ ...r, actual_score: Math.max(1, r.expected_score - 1) }));
    const g = gate(rows);
    expect(g.pass).toBe(false);
    expect(g.failures.join(" ")).toContain("exact match");
  });

  // STRICT on the adversarial rows: getting the comp carve-out wrong produces a
  // role the table hides while its score reads 4 — a silent inconsistency, not a
  // shifted distribution.
  test("one wrong adversarial case fails even at perfect aggregate agreement", () => {
    for (const c of ADVERSARIAL_CASES) {
      const rows = perfect();
      const row = rows.find((r) => r.company === c.company)!;
      row.actual_score = c.expected === 3 ? 4 : 3;
      const g = gate(rows);
      expect(g.pass, `${c.company} disagreement was not caught`).toBe(false);
      expect(g.failures.join(" ")).toContain(c.company);
    }
  });

  test("a missing adversarial row fails rather than being skipped", () => {
    const rows = perfect().filter((r) => r.company !== "Bandtop AI");
    expect(gate(rows).pass).toBe(false);
    expect(gate(rows).failures.join(" ")).toContain("missing");
  });
});
