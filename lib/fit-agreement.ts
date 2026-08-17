/**
 * How closely a second model agrees with the golden set.
 *
 * This is a SHIP GATE, not a metric. Fit scores were measured as effectively
 * deterministic — ten roles, three rounds, zero variance — so there is no noise
 * for a cross-model difference to hide in. If another model scores a role 3
 * where Claude scores 4, the user's table re-sorts permanently and nothing on
 * screen explains it.
 *
 * The two adversarial rows matter more than the aggregate. Both encode multi-hop
 * precedence under contradiction, which is the first capability to degrade below
 * the frontier — and their failure mode is not a softer distribution, it is the
 * defect the code comments already name: "a role the table hides while its fit
 * score still reads 4."
 */

export interface Scored {
  company: string;
  role_title: string;
  expected_score: number;
  actual_score: number;
}

export interface Agreement {
  exactMatch: number;      // 0..1
  meanAbsoluteDeviation: number;
  within1: number;         // 0..1
  worst: { company: string; expected: number; actual: number } | null;
}

export function agreement(rows: readonly Scored[]): Agreement {
  if (rows.length === 0) {
    // Not 100% — an empty comparison has agreed about nothing, and reporting
    // perfect agreement for it would let a broken harness pass the gate.
    return { exactMatch: 0, meanAbsoluteDeviation: 0, within1: 0, worst: null };
  }
  let exact = 0, within = 0, total = 0;
  let worst: Agreement["worst"] = null;

  for (const r of rows) {
    const d = Math.abs(r.expected_score - r.actual_score);
    total += d;
    if (d === 0) exact++;
    if (d <= 1) within++;
    if (!worst || d > Math.abs(worst.expected - worst.actual)) {
      worst = { company: r.company, expected: r.expected_score, actual: r.actual_score };
    }
  }
  return {
    exactMatch: exact / rows.length,
    meanAbsoluteDeviation: total / rows.length,
    within1: within / rows.length,
    worst,
  };
}

/** The rules a provider must reproduce, whatever its aggregate agreement. */
export const ADVERSARIAL_CASES = [
  {
    company: "Bandtop AI",
    expected: 3,
    rule: "A band whose TOP only reaches the comp floor must cap at 3, even under the AI-GTM rule's floor of 4 — the carve-out outranks it.",
  },
  {
    company: "Quietco",
    expected: 4,
    rule: "Unknown ARR, backer and exit signal must NOT deduct. Most postings publish no financials; treating silence as negative caps every role at a company that simply did not say.",
  },
] as const;

export interface GateResult {
  pass: boolean;
  failures: string[];
}

/**
 * Whether a provider may ship.
 *
 * Deliberately strict on the adversarial rows and loose on the aggregate: a
 * model that is half a point harsher across the board is usable (the user's
 * whole table shifts together), while one that gets the comp carve-out wrong
 * produces a role the table hides while its score reads 4.
 */
export function gate(rows: readonly Scored[], minExactMatch = 0.7): GateResult {
  const failures: string[] = [];
  const a = agreement(rows);

  if (rows.length === 0) failures.push("no rows were scored — the harness did not run");
  if (a.exactMatch < minExactMatch) {
    failures.push(
      `exact match ${(a.exactMatch * 100).toFixed(0)}% is below the ${(minExactMatch * 100).toFixed(0)}% floor`
    );
  }
  for (const c of ADVERSARIAL_CASES) {
    const row = rows.find((r) => r.company === c.company);
    if (!row) {
      failures.push(`adversarial case missing from the run: ${c.company}`);
    } else if (row.actual_score !== c.expected) {
      failures.push(
        `${c.company} scored ${row.actual_score}, expected ${c.expected} — ${c.rule}`
      );
    }
  }
  return { pass: failures.length === 0, failures };
}
