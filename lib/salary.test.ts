import { describe, expect, test, vi } from "vitest";
import { baseMaxFor, parseSalaryRange } from "./salary";

describe("parseSalaryRange", () => {
  test("parses the simple range", () => {
    expect(parseSalaryRange("$141,400 - $203,800")).toEqual({
      kind: "base",
      min: 141400,
      max: 203800,
    });
  });

  test("prefers the labeled base range over the OTE range", () => {
    // The naive "highest max" rule picks $365,000 OTE here. In GTM roles OTE
    // bundles commission and overstates base by 20-40%, so a minimum-BASE
    // floor built on that rule silently passes roles whose base is under it.
    const r = parseSalaryRange("$280,000 - $325,000 (base); $305,000 - $365,000 OTE");
    expect(r).toEqual({ kind: "base", min: 280000, max: 325000 });
  });

  test("takes the first range when several are location-scoped and none is labeled base", () => {
    const r = parseSalaryRange("$138,945 - $165,000 (Denver); $168,420 - $200,000 (SF/NYC)");
    expect(r).toEqual({ kind: "base", min: 138945, max: 165000 });
  });

  test("handles a base range with trailing prose", () => {
    expect(parseSalaryRange("$165,000 - $175,000 base + annual bonus")).toEqual({
      kind: "base",
      min: 165000,
      max: 175000,
    });
  });

  test("marks an OTE-only figure as OTE, not base", () => {
    expect(parseSalaryRange("$300,000 - $340,000 OTE")).toEqual({
      kind: "ote",
      min: 300000,
      max: 340000,
    });
  });

  test("handles a bare single value as a range of one point", () => {
    // Treating this as unparseable would tag a perfectly good $150k role as
    // "no range listed".
    expect(parseSalaryRange("$150,000")).toEqual({
      kind: "base",
      min: 150000,
      max: 150000,
    });
  });

  test("prefers a labeled base range even when it is NOT the first segment", () => {
    // THE test for the headline rule. Without it, deleting the `labeledBase`
    // branch entirely leaves all six production strings byte-identical and the
    // whole suite green — verified by execution, not inspection. In the
    // `(base); …OTE` string labeledBase and nonOte are the same object, and the
    // `base + annual bonus` string has only one segment, so neither
    // discriminates. This one does.
    expect(parseSalaryRange("$120,000 - $140,000 (Denver); $180,000 - $200,000 base (SF)"))
      .toEqual({ kind: "base", min: 180000, max: 200000 });
  });

  test("handles the k/K suffixes the app's own editor teaches", () => {
    // components/RolesTable.tsx's salary editor carries the placeholder
    // "e.g. $200K–$280K" — the app teaches a format the first-draft parser
    // rejected. A silently-unparseable manual entry shows as "no range listed"
    // with no indication anything went wrong.
    expect(parseSalaryRange("$200K - $280K")).toEqual({ kind: "base", min: 200000, max: 280000 });
    expect(parseSalaryRange("$150k")).toEqual({ kind: "base", min: 150000, max: 150000 });
    // The placeholder's separator is an en dash, not a hyphen — copy it verbatim.
    expect(parseSalaryRange("$200K–$280K")).toEqual({ kind: "base", min: 200000, max: 280000 });
    // A fractional k figure is a real posting shape ("$162.5k").
    expect(parseSalaryRange("$162.5k")).toEqual({ kind: "base", min: 162500, max: 162500 });
    // A space after the dollar sign is a common extraction artifact.
    expect(parseSalaryRange("$ 150,000")).toEqual({ kind: "base", min: 150000, max: 150000 });
  });

  test("a comma-separated base/OTE pair does not merge into one mangled range", () => {
    // Splitting only on ';' yields {kind:"ote", min:280000, max:365000} — a
    // range spanning base-min to OTE-max, then bucketed "below". Verified.
    expect(parseSalaryRange("$280,000 - $325,000 base, $305,000 - $365,000 OTE"))
      .toEqual({ kind: "base", min: 280000, max: 325000 });
  });

  test("does not split on a thousands separator", () => {
    // The segment split must distinguish "$325,000 base, $305,000 OTE" from the
    // comma inside "$325,000". Splitting on every comma would leave segments
    // holding "000" fragments with no '$' and drop half the figures.
    expect(parseSalaryRange("$141,400 - $203,800, depending on experience")).toEqual({
      kind: "base",
      min: 141400,
      max: 203800,
    });
  });

  test("a segment that mentions base but is itself the OTE figure stays OTE", () => {
    // Guards the `!OTE.test(...)` half of the labeled-base rule: without it this
    // string reads as a base range of $305k-$365k and clears a $300k base floor
    // it should not clear.
    expect(parseSalaryRange("$305,000 - $365,000 OTE (base not disclosed)")).toEqual({
      kind: "ote",
      min: 305000,
      max: 365000,
    });
  });

  test("ignores dollar figures too small to be an annual salary", () => {
    // A stipend or signing bonus in the same segment must not become the range
    // minimum: min would read $500 and clear any floor.
    expect(parseSalaryRange("$165,000 - $175,000 base + $500 monthly wellness stipend")).toEqual({
      kind: "base",
      min: 165000,
      max: 175000,
    });
    // Without the floor, this whole role reads as a $500 range: the stipend is
    // the first unlabeled segment and wins the segment choice outright.
    expect(parseSalaryRange("$500 monthly stipend; $150,000 - $170,000")).toEqual({
      kind: "base",
      min: 150000,
      max: 170000,
    });
  });

  test("reads on-target earnings spelled out as OTE", () => {
    // `on[- ]target` in the OTE pattern is load-bearing: without it this string
    // classifies as `base` and clears a base floor it should not — the exact
    // false pass the base-over-OTE rule exists to prevent.
    expect(parseSalaryRange("on-target earnings of $300,000 - $340,000")).toEqual({
      kind: "ote",
      min: 300000,
      max: 340000,
    });
    expect(parseSalaryRange("On target earnings $300,000 - $340,000").kind).toBe("ote");
  });

  test("does not read 'based' or 'Note' as the base and OTE labels", () => {
    // Both label patterns carry \b for a reason. Without it on BASE, the
    // Denver-based segment claims the base label and wins over the real one;
    // without it on OTE, the word "Note" turns a base range into an OTE range.
    expect(parseSalaryRange("$120,000 - $140,000 (Denver-based); $180,000 - $200,000 base (SF)"))
      .toEqual({ kind: "base", min: 180000, max: 200000 });
    expect(parseSalaryRange("Note: $140,000 - $160,000")).toEqual({
      kind: "base",
      min: 140000,
      max: 160000,
    });
  });

  test("does not read a following word as a k suffix", () => {
    // Stripped-HTML text (lib/crawler.ts) routinely joins adjacent elements
    // with no space. Without the (?![A-Za-z]) lookahead this is $150,000,000.
    expect(parseSalaryRange("$150,000Kansas City")).toEqual({
      kind: "base",
      min: 150000,
      max: 150000,
    });
  });

  describe("extracts the range pair, not every figure in the segment", () => {
    // baseMaxFor returns `max`, which is what the comp floor compares against.
    // Spanning every figure in the segment lets equity, bonuses and signing
    // figures set that number — the same false-pass class as picking OTE over
    // base, one scope narrower.
    test("equity alongside base does not become the range max", () => {
      expect(parseSalaryRange("$150,000 base + $200,000 equity")).toEqual({
        kind: "base",
        min: 150000,
        max: 150000,
      });
      expect(baseMaxFor(parseSalaryRange("$150,000 base + $200,000 equity"))).toBe(150000);
    });

    test("a signing bonus does not become the range min", () => {
      expect(parseSalaryRange("$85,000 - $95,000 plus a $10,000 signing bonus")).toEqual({
        kind: "base",
        min: 85000,
        max: 95000,
      });
    });

    test("finds the dash pair even when a stray figure comes first", () => {
      expect(parseSalaryRange("$10,000 signing bonus and $150,000 - $170,000 base")).toEqual({
        kind: "base",
        min: 150000,
        max: 170000,
      });
    });

    test("accepts hyphen, en dash, em dash and 'to' as the pair separator", () => {
      const expected = { kind: "base", min: 150000, max: 170000 };
      expect(parseSalaryRange("$150,000-$170,000")).toEqual(expected);
      expect(parseSalaryRange("$150,000 – $170,000")).toEqual(expected);
      expect(parseSalaryRange("$150,000 — $170,000")).toEqual(expected);
      expect(parseSalaryRange("$150,000 to $170,000")).toEqual(expected);
    });

    test("two figures with no separator are not a range", () => {
      // "$150,000 $200,000" is not a range anyone wrote on purpose; taking the
      // first figure is the conservative read for a floor comparison.
      expect(parseSalaryRange("$150,000 salary $200,000 equity grant")).toEqual({
        kind: "base",
        min: 150000,
        max: 150000,
      });
      // The separator match is anchored to the whole gap. Unanchored, the "to"
      // inside "total" makes this a $150k-$250k range.
      expect(parseSalaryRange("$150,000 salary, total comp $250,000")).toEqual({
        kind: "base",
        min: 150000,
        max: 150000,
      });
    });
  });

  describe("a per-period figure is not an annual base", () => {
    // THE bug: every figure here is compared against an ANNUAL floor. Read as
    // annual, `$4,500 per week` — $234,000 a year — buckets `below` a $180,000
    // floor and the row disappears from the table, while scoreFit gets the raw
    // string and reads it correctly. Routed to `unparseable`, which "Meets
    // minimum" does not hide, rather than annualized: 52 weeks is a guess, and
    // hours-per-week is a bigger one.
    const SUB_ANNUAL = [
      "$4,500 per week",
      "$4,500/week",
      "$4,500 weekly",
      "$4,500 per wk",
      "$12,000 per month",
      "$12,000/month",
      "$12,000 monthly",
      "$12,000 /mo",
      "$12,000 a month",
      "$1,500 per day",
      "$1,500 daily",
      "$1,200 per hour",
      "$1,200/hr",
      "$1,200 hourly",
      "$4,500 - $5,000 per week",
      "$4,500 to $5,000 per month",
      "$12,000 per month (base)",
      "$4,500 (per week)",
      // The `"i"` flag, which nothing pinned before: postings capitalize.
      "$4,500 Per Week",
      "$12,000 Monthly",
      "$12,000 /Mo",
    ];

    test("every sub-annual form refuses to be read as a base range", () => {
      expect(SUB_ANNUAL.length).toBe(21);
      for (const raw of SUB_ANNUAL) {
        expect(parseSalaryRange(raw)).toEqual({ kind: "unparseable", raw });
        // The point of the whole rule: nothing reaches the floor comparison.
        expect(baseMaxFor(parseSalaryRange(raw))).toBeNull();
      }
    });

    // The other half, and the one that matters more: a rule that rejected
    // everything would pass the test above. Rejecting `per year` would hide far
    // more roles than the bug being fixed.
    const ANNUAL = [
      ["$180,000 per year", 180000, 180000],
      ["$180,000/year", 180000, 180000],
      ["$180,000/yr", 180000, 180000],
      ["$180,000 per yr", 180000, 180000],
      ["$180,000 annually", 180000, 180000],
      ["$180,000 annual", 180000, 180000],
      ["$180,000 per annum", 180000, 180000],
      ["$180,000 a year", 180000, 180000],
      ["$180,000 - $220,000 per year", 180000, 220000],
      ["$180,000 - $220,000 annually", 180000, 220000],
      ["$180,000 - $220,000 (annual base)", 180000, 220000],
      // Spellings the first draft of this list left unpinned. Each one is a
      // real posting shape, and each is one alternation entry away from being
      // hidden by the rule above.
      ["$180,000 yearly", 180000, 180000],
      ["$180,000 p.a.", 180000, 180000],
      ["$180,000 USD/year", 180000, 180000],
      ["$180,000 annualized", 180000, 180000],
      ["$180,000 each year", 180000, 180000],
      ["$180,000 Per Year", 180000, 180000],
    ] as const;

    test("every annual form still parses as base", () => {
      expect(ANNUAL.length).toBe(17);
      for (const [raw, min, max] of ANNUAL) {
        expect(parseSalaryRange(raw)).toEqual({ kind: "base", min, max });
      }
    });

    test("a period word about some OTHER figure does not poison the range", () => {
      // The qualifier is anchored to the character after the figure, never
      // searched across the segment. A segment-wide search makes both of these
      // unreadable — the second is already a regression test for the
      // MIN_PLAUSIBLE_SALARY rule.
      expect(
        parseSalaryRange("$165,000 - $175,000 base + $500 monthly wellness stipend")
      ).toEqual({ kind: "base", min: 165000, max: 175000 });
      expect(parseSalaryRange("$500 monthly stipend; $150,000 - $170,000")).toEqual({
        kind: "base",
        min: 150000,
        max: 170000,
      });
      // "monthly" here describes the bonus, not the salary that precedes it.
      expect(parseSalaryRange("$150,000 - $170,000 plus a monthly bonus")).toEqual({
        kind: "base",
        min: 150000,
        max: 170000,
      });
      // Nor does a unit buried inside a longer word: "more" is not "mo".
      expect(parseSalaryRange("$150,000 or more, depending on experience")).toEqual({
        kind: "base",
        min: 150000,
        max: 150000,
      });
      // Why the unit alternation carries a trailing \b: a city name eats "day".
      expect(parseSalaryRange("$150,000 - $170,000 (Dayton)")).toEqual({
        kind: "base",
        min: 150000,
        max: 170000,
      });
      // Why the abbreviations require a "per"/"/" lead-in: a bare `hr` claims
      // this string, and a real $150k role becomes "Range unreadable".
      expect(parseSalaryRange("$150,000 HR Manager")).toEqual({
        kind: "base",
        min: 150000,
        max: 150000,
      });
    });

    test("a unit NOUN next to the figure is not a rate without a per or a slash", () => {
      // L6. The -ly adverbs qualify a figure on their own ("$4,500 weekly" has
      // no other reading); the bare nouns do not. Left standing alone they
      // claimed a genuine $180-220k salary and labelled it "Range unreadable" —
      // the wrong answer in the feature whose whole point is reading ranges.
      const NOUN_PROSE = [
        "$180,000 - $220,000 hours are flexible",
        "$180,000 - $220,000 days off unlimited",
        "$180,000 - $220,000 Month 1 ramp",
        "$180,000 - $220,000 week one bonus",
        "$180,000 - $220,000 month-end close ownership",
        "$180,000 - $220,000 weeks of PTO included",
      ];
      expect(NOUN_PROSE.length).toBe(6);
      for (const raw of NOUN_PROSE) {
        expect(parseSalaryRange(raw)).toEqual({ kind: "base", min: 180000, max: 220000 });
      }
      // The lead-in is what turns the same noun into a rate, both spellings.
      expect(parseSalaryRange("$4,500 per week").kind).toBe("unparseable");
      expect(parseSalaryRange("$4,500/week").kind).toBe("unparseable");
    });

    test("an OTE figure stays OTE even when it carries a period qualifier", () => {
      // Deliberate precedence. OTE never reaches the floor comparison
      // (baseMaxFor returns null), so demoting it to `unparseable` fixes
      // nothing — and `unparseable` IS hidden by "Hide no range listed" while
      // `ote` is not, so the demotion would newly hide a priced role. The
      // employer published a range; it just is not a base.
      expect(parseSalaryRange("$12,000 per month OTE")).toEqual({
        kind: "ote",
        min: 12000,
        max: 12000,
      });
      expect(baseMaxFor(parseSalaryRange("$12,000 per month OTE"))).toBeNull();
    });

    test("logs the refusal with its own sentence", () => {
      // "We found a figure and refuse to treat it as annual" is a different
      // fact from "we found no figures", and it is the only trace of a role
      // that quietly became untagged-comparable.
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        parseSalaryRange("$4,500 per week");
        expect(warn).toHaveBeenCalledTimes(1);
        const line = String(warn.mock.calls[0][0]);
        expect(line).toContain("$4,500 per week");
        expect(line).toContain("per-period");
        warn.mockClear();
        parseSalaryRange("$180,000 per year");
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });
  });

  test("distinguishes empty input from unparseable input", () => {
    expect(parseSalaryRange("")).toEqual({ kind: "absent" });
    expect(parseSalaryRange(null)).toEqual({ kind: "absent" });
    expect(parseSalaryRange("   ")).toEqual({ kind: "absent" });
    expect(parseSalaryRange("Competitive salary DOE")).toEqual({
      kind: "unparseable",
      raw: "Competitive salary DOE",
    });
  });

  test("logs the unparseable case", () => {
    // "We captured text we could not read" is a parser bug that would otherwise
    // never surface — it must reach the logs, not just the return value.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      parseSalaryRange("Competitive salary DOE");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("Competitive salary DOE");
      warn.mockClear();
      parseSalaryRange("");
      parseSalaryRange("$150,000");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("ignores a bare year that would otherwise look like a number", () => {
    expect(parseSalaryRange("Posted 2026").kind).not.toBe("base");
  });

  test("every real production string is handled without throwing", () => {
    const REAL = [
      "$141,400 - $203,800",
      "$280,000 - $325,000 (base); $305,000 - $365,000 OTE",
      "$138,945 - $165,000 (Denver); $168,420 - $200,000 (SF/NYC)",
      "$165,000 - $175,000 base + annual bonus",
      "$300,000 - $340,000 OTE",
      "$150,000",
    ];
    expect(REAL.length).toBe(6);
    for (const raw of REAL) {
      const r = parseSalaryRange(raw);
      expect(r.kind).not.toBe("unparseable");
    }
  });

  test("min is never above max", () => {
    const REAL = [
      "$141,400 - $203,800",
      "$280,000 - $325,000 (base); $305,000 - $365,000 OTE",
      "$138,945 - $165,000 (Denver); $168,420 - $200,000 (SF/NYC)",
      "$165,000 - $175,000 base + annual bonus",
      "$300,000 - $340,000 OTE",
      "$150,000",
      "$200K - $280K",
    ];
    expect(REAL.length).toBe(7);
    for (const raw of REAL) {
      const r = parseSalaryRange(raw);
      if (r.kind !== "base" && r.kind !== "ote") throw new Error(`unexpected kind for ${raw}`);
      expect(r.min).toBeLessThanOrEqual(r.max);
      expect(r.min).toBeGreaterThan(0);
    }
  });
});

describe("baseMaxFor", () => {
  test("returns the max of a base range", () => {
    expect(baseMaxFor(parseSalaryRange("$141,400 - $203,800"))).toBe(203800);
  });

  test("returns null for OTE, absent and unparseable — OTE never clears a base floor", () => {
    expect(baseMaxFor(parseSalaryRange("$300,000 - $340,000 OTE"))).toBeNull();
    expect(baseMaxFor(parseSalaryRange(""))).toBeNull();
    expect(baseMaxFor(parseSalaryRange("Competitive salary DOE"))).toBeNull();
  });
});
