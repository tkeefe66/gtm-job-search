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
//
// It is NOT the defense against per-period pay. It catches hourly rates only by
// accident (`$95/hour` is under it), and lets `$4,500 per week` — $234,000 a
// year — through as though it were an annual figure. SUB_ANNUAL_PERIOD below is
// the deliberate half.
const MIN_PLAUSIBLE_SALARY = 1000;

/**
 * A pay-period qualifier sitting immediately after a dollar figure, naming a
 * period SHORTER than a year.
 *
 * Every figure this module returns is compared against an ANNUAL floor
 * (`baseMaxFor` → `salaryBucketFor`). `$4,500 per week` is $234,000 a year; read
 * as annual it buckets `below` a $180,000 floor and the row vanishes from the
 * table, while `scoreFit` — which gets the raw string and reads it correctly —
 * likes the role. That is the same incommensurable-comparison failure the "ote"
 * kind exists to prevent, so it gets the same treatment: refuse to compare.
 *
 * Refuse, not annualize. Turning `$4,500 per week` into an annual number means
 * guessing 52 weeks and, for hourly, a hours-per-week the posting never stated;
 * a wrong guess hides a role exactly as silently as no guess at all. The
 * `unparseable` kind already means "do not compare this", and "Meets minimum"
 * does not hide it.
 *
 * ANCHORED at the character following the figure, never searched across the
 * segment. `$165,000 - $175,000 base + $500 monthly wellness stipend` says
 * "monthly" about a figure that is not the salary, and a segment-wide search
 * would make that role unreadable.
 *
 * Annual qualifiers are deliberately absent from the alternation, so
 * `per year`, `/yr`, `annually` and `per annum` keep parsing as `base` —
 * rejecting those would hide far more roles than this rule saves.
 */
const SUB_ANNUAL_PERIOD = new RegExp(
  "^[\\s()]*(?:" +
    // Abbreviations REQUIRE a "per"/"/" lead-in. Bare `hr` would claim
    // "$150,000 HR Manager", and bare `mo` is a word fragment.
    "(?:(?:per|an|a|each)\\s+|/\\s?)(?:hrs?|wks?|mos?)" +
    "|" +
    // Spelled-out periods stand on their own — "$4,500 weekly" carries no
    // "per" — and take the same optional lead-in.
    "(?:(?:per|an|a|each)\\s+|/\\s?)?(?:hourly|daily|weekly|monthly|hours?|days?|weeks?|months?)" +
    ")\\b",
  "i"
);

// What sits between the two halves of a written range. The en dash is here
// because the app's own salary editor teaches "$200K–$280K"; "to" is here
// because postings write it out. Anything else between two figures means they
// are two different facts (a salary and an equity grant), not one range.
const RANGE_SEPARATOR = /^\s*(?:-{1,2}|–|—|to)\s*$/i;

interface Figure {
  value: number;
  start: number;
  end: number;
  /** True when a sub-annual pay period follows this figure — see SUB_ANNUAL_PERIOD. */
  subAnnual: boolean;
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
function rangeOf(seg: Segment): { min: number; max: number; subAnnual: boolean } {
  const figs = seg.figures;
  for (let i = 0; i + 1 < figs.length; i++) {
    if (RANGE_SEPARATOR.test(seg.text.slice(figs[i].end, figs[i + 1].start))) {
      return {
        min: Math.min(figs[i].value, figs[i + 1].value),
        max: Math.max(figs[i].value, figs[i + 1].value),
        // Either endpoint. `$4,500 - $5,000 per week` qualifies only the second
        // figure; `$4,500/week - $5,000/week` only the first, because the gap
        // then fails RANGE_SEPARATOR and the lone-figure fallback takes over.
        subAnnual: figs[i].subAnnual || figs[i + 1].subAnnual,
      };
    }
  }
  return { min: figs[0].value, max: figs[0].value, subAnnual: figs[0].subAnnual };
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
        .map((m) => {
          const end = (m.index ?? 0) + m[0].length;
          return {
            value: Number(m[1].replace(/,/g, "")) * (m[2] ? 1000 : 1),
            start: m.index ?? 0,
            end,
            subAnnual: SUB_ANNUAL_PERIOD.test(text.slice(end)),
          };
        })
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
 * A figure qualified by a period shorter than a year is `unparseable`, not
 * `base`: every consumer of a `base` range compares it against an ANNUAL floor.
 * See SUB_ANNUAL_PERIOD.
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
  //
  // OTE OUTRANKS the period qualifier, deliberately. A string can carry both
  // (`$12,000 per month OTE`), and the period rule exists to stop a figure
  // reaching a floor comparison it is not commensurable with — which an OTE
  // figure never does (`baseMaxFor` returns null for it). Demoting this to
  // `unparseable` would fix nothing and would newly hide the row under "Hide no
  // range listed", which hides `unreadable` but not `ote`: a smaller copy of the
  // bug being fixed here. The employer published a range; it is just not a base.
  if (!chosen) {
    const { min, max } = rangeOf(parts[0]);
    return { kind: "ote", min, max };
  }

  const { min, max, subAnnual } = rangeOf(chosen);
  if (subAnnual) {
    // Logged, and with its own sentence: this is not "we found no figures", it
    // is "we found one and refuse to treat it as annual". Without the line, the
    // only trace of the decision is a row tagged "Range unreadable".
    console.warn(
      `parseSalaryRange: refusing to read a per-period figure as an annual ` +
        `base in ${JSON.stringify(raw)}`
    );
    return { kind: "unparseable", raw };
  }
  return { kind: "base", min, max };
}

/** The figure a minimum-base floor is compared against. OTE never qualifies. */
export function baseMaxFor(parsed: ParsedSalary): number | null {
  return parsed.kind === "base" ? parsed.max : null;
}
