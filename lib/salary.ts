export type ParsedSalary =
  | { kind: "base"; min: number; max: number }
  | { kind: "ote"; min: number; max: number }
  | { kind: "absent" }
  | { kind: "unparseable"; raw: string };

// A dollar figure, with optional thousands separators and an optional k/K
// suffix. The $ is required: it is what separates a salary from a year, a
// headcount, or a street number. The k suffix is required because the app's own
// salary editor teaches "$200K–$280K" (components/RolesTable.tsx placeholder) —
// without it a hand-typed entry reads as "no range listed".
// The lookahead keeps "$150,000 Kilobytes"-shaped text from eating the K.
const MONEY = /\$\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(?:(k)(?![A-Za-z]))?/gi;

// Below this, a "$" figure is a stipend, a bonus, or a fee — never an annual
// base. Without the floor, "+ $500 monthly stipend" becomes the range minimum.
const MIN_PLAUSIBLE_SALARY = 1000;

interface Segment {
  text: string;
  numbers: number[];
}

function segments(raw: string): Segment[] {
  // Employers separate multiple ranges with a semicolon far more consistently
  // than with anything else; splitting on it is what lets the base/OTE and the
  // Denver/SF strings be told apart rather than mashed into one number soup.
  // A comma also separates ranges — but only when the next thing is another
  // dollar figure, since a bare comma is a thousands separator.
  return raw
    .split(/;|,(?=\s*\$)/)
    .map((text) => {
      const numbers = Array.from(text.matchAll(MONEY))
        .map((m) => Number(m[1].replace(/,/g, "")) * (m[2] ? 1000 : 1))
        .filter((n) => Number.isFinite(n) && n >= MIN_PLAUSIBLE_SALARY);
      return { text, numbers };
    })
    .filter((s) => s.numbers.length > 0);
}

const OTE = /\bOTE\b|on[- ]target/i;
const BASE = /\bbase\b/i;

/**
 * Parses a posting's salary string into a comparable range.
 *
 * Precedence is deliberate: an explicitly-labeled base segment wins, then the
 * first unlabeled segment, and an OTE-only string is reported as OTE rather
 * than silently compared against a base floor. In GTM roles OTE bundles
 * commission and overstates base by 20-40%, so a "highest max" rule would pick
 * $365,000 OTE over $325,000 base and pass roles whose base is under the floor.
 *
 * Returns four distinct outcomes rather than a nullable range, because
 * "the employer published nothing" and "we captured text we could not read"
 * are different facts — the second is a parser bug that would otherwise never
 * surface, so it is logged.
 */
export function parseSalaryRange(raw: string | null | undefined): ParsedSalary {
  if (!raw || !raw.trim()) return { kind: "absent" };

  const parts = segments(raw);
  if (parts.length === 0) {
    console.warn(`parseSalaryRange: no salary figures found in ${JSON.stringify(raw)}`);
    return { kind: "unparseable", raw };
  }

  const labeledBase = parts.find((p) => BASE.test(p.text) && !OTE.test(p.text));
  const nonOte = parts.find((p) => !OTE.test(p.text));
  const chosen = labeledBase ?? nonOte;
  // Every remaining segment is OTE-labeled, so report OTE rather than pretend
  // the figure is a base range.
  if (!chosen) {
    const nums = parts[0].numbers;
    return { kind: "ote", min: Math.min(...nums), max: Math.max(...nums) };
  }

  return { kind: "base", min: Math.min(...chosen.numbers), max: Math.max(...chosen.numbers) };
}

/** The figure a minimum-base floor is compared against. OTE never qualifies. */
export function baseMaxFor(parsed: ParsedSalary): number | null {
  return parsed.kind === "base" ? parsed.max : null;
}
