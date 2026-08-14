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

// What sits between the two halves of a written range. The en dash is here
// because the app's own salary editor teaches "$200K–$280K"; "to" is here
// because postings write it out. Anything else between two figures means they
// are two different facts (a salary and an equity grant), not one range.
const RANGE_SEPARATOR = /^\s*(?:-{1,2}|–|—|to)\s*$/i;

interface Figure {
  value: number;
  start: number;
  end: number;
}

interface Segment {
  text: string;
  figures: Figure[];
}

/**
 * The range a segment states, which is NOT the span of every figure it
 * mentions. `$150,000 base + $200,000 equity` is a $150k role: spanning both
 * figures would hand `baseMaxFor` the equity grant and clear a $180k floor on
 * stock. So: the first pair of figures joined by a range separator wins, and a
 * lone figure is only the fallback.
 */
function rangeOf(seg: Segment): { min: number; max: number } {
  const figs = seg.figures;
  for (let i = 0; i + 1 < figs.length; i++) {
    if (RANGE_SEPARATOR.test(seg.text.slice(figs[i].end, figs[i + 1].start))) {
      return {
        min: Math.min(figs[i].value, figs[i + 1].value),
        max: Math.max(figs[i].value, figs[i + 1].value),
      };
    }
  }
  return { min: figs[0].value, max: figs[0].value };
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
      const figures = Array.from(text.matchAll(MONEY))
        .map((m) => ({
          value: Number(m[1].replace(/,/g, "")) * (m[2] ? 1000 : 1),
          start: m.index ?? 0,
          end: (m.index ?? 0) + m[0].length,
        }))
        .filter((f) => Number.isFinite(f.value) && f.value >= MIN_PLAUSIBLE_SALARY);
      return { text, figures };
    })
    .filter((s) => s.figures.length > 0);
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
  if (!chosen) return { kind: "ote", ...rangeOf(parts[0]) };

  return { kind: "base", ...rangeOf(chosen) };
}

/** The figure a minimum-base floor is compared against. OTE never qualifies. */
export function baseMaxFor(parsed: ParsedSalary): number | null {
  return parsed.kind === "base" ? parsed.max : null;
}
