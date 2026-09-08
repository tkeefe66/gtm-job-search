/**
 * What the chat agent may retune about the document, and how a value is proved
 * safe. ONE module, because the write path and the sanitizer must agree: a
 * value the agent cannot set must also be a value that cannot be saved.
 *
 * Every token here was verified to have a consumer — `grep -rF "var(--x"` over
 * public/resume-design. Five obvious-looking candidates were dropped because
 * nothing reads them (--page-margin, --stack-entry, --col-side, --measure-prose,
 * --text-accent): setting one changes nothing while the agent reports success.
 * A test re-derives that from the stylesheets so the list cannot rot.
 *
 * --rule-200 is here alongside --rule-100 because --rule-100 alone reaches only
 * .rsm-role's bottom hairline (document.css:37); the section rules go through
 * --border-rule -> --rule-200 (document.css:22, colors.css:21), so without both
 * "change the rule colour" changes half the rules.
 *
 * Excluded on purpose: --page-width/--page-height (a document that is not US
 * Letter prints wrong with no on-screen symptom), the font families (an
 * unloaded face falls back silently), everything in elevation.css (screen-only).
 *
 * NO /u FLAG AND NO \p{...} IN THIS FILE. tsconfig declares no target, so the
 * build typechecks at ES5 and either passes vitest then fails `npm run build`
 * (lib/resume-sanitize.ts:27 carries the same warning).
 */

interface TokenSpec {
  name: string;
  kind: "length" | "color";
  min?: number;
  max?: number;
  units?: string[];
}

const LENGTH_UNITS = ["px", "pt", "rem", "em", "%", "ch"];

export const DESIGN_TOKENS: TokenSpec[] = [
  { name: "--rail", kind: "length", min: 40, max: 260, units: LENGTH_UNITS },
  { name: "--gap-bullet", kind: "length", min: 0, max: 48, units: LENGTH_UNITS },
  { name: "--type-body", kind: "length", min: 6, max: 24, units: LENGTH_UNITS },
  { name: "--type-meta", kind: "length", min: 5, max: 20, units: LENGTH_UNITS },
  { name: "--type-name", kind: "length", min: 12, max: 72, units: LENGTH_UNITS },
  { name: "--type-org", kind: "length", min: 6, max: 24, units: LENGTH_UNITS },
  { name: "--type-role", kind: "length", min: 6, max: 28, units: LENGTH_UNITS },
  { name: "--type-section", kind: "length", min: 5, max: 20, units: LENGTH_UNITS },
  { name: "--leading-tight", kind: "length", min: 0.8, max: 2.4, units: LENGTH_UNITS.concat([""]) },
  { name: "--tracking-tight", kind: "length", min: -0.1, max: 0.5, units: LENGTH_UNITS.concat([""]) },
  { name: "--ink-900", kind: "color" },
  { name: "--text-primary", kind: "color" },
  { name: "--rule-100", kind: "color" },
  { name: "--rule-200", kind: "color" },
  { name: "--link", kind: "color" },
];

// Built with a NULL prototype, not `{}`. A plain object literal inherits
// Object.prototype, so SPEC_BY_NAME["constructor"] (or "toString",
// "hasOwnProperty", "__proto__", ...) would resolve to the inherited member
// instead of `undefined` — an object/function, which is truthy — and fool
// `parseTokenValue`'s `if (!spec)` allowlist check into treating a name
// nothing in DESIGN_TOKENS declares as adjustable. Object.create(null) has
// no prototype at all, so a bracket read of any name never in this map
// returns plain `undefined`, exactly like a Map would, with no lookup-site
// hasOwnProperty guard needed.
const SPEC_BY_NAME: Record<string, TokenSpec> = Object.create(null);
DESIGN_TOKENS.forEach((t) => {
  SPEC_BY_NAME[t.name] = t;
});

// Anchored, no /u flag. A value is a number plus an optional allowed unit, or a
// colour in one of three shapes. Anchoring is what rejects "1px } .rsm { ... }".
const LENGTH_RE = /^-?[0-9]+(\.[0-9]+)?(px|pt|rem|em|%|ch)?$/;
const OKLCH_RE = /^oklch\([0-9. ]+(\/[0-9. ]+)?\)$/;
const HEX_RE = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;
const NAMED_COLORS = ["black", "white", "transparent", "currentColor", "inherit"];

function parseLength(spec: TokenSpec, value: string): { value?: string; error?: string } {
  const trimmed = value.trim();
  if (!LENGTH_RE.test(trimmed)) {
    return { error: trimmed + " is not a plain length (a number, optionally with px/pt/rem/em/%/ch)." };
  }
  const unit = trimmed.replace(/^-?[0-9.]+/, "");
  const units = spec.units || LENGTH_UNITS;
  if (units.indexOf(unit) === -1) {
    return { error: (unit || "a bare number") + " is not an accepted unit for " + spec.name + "." };
  }
  const n = parseFloat(trimmed);
  if (spec.min != null && n < spec.min) return { error: spec.name + " must be at least " + spec.min + "." };
  if (spec.max != null && n > spec.max) return { error: spec.name + " must be at most " + spec.max + "." };
  return { value: trimmed };
}

function parseColor(spec: TokenSpec, value: string): { value?: string; error?: string } {
  const trimmed = value.trim();
  if (OKLCH_RE.test(trimmed) || HEX_RE.test(trimmed) || NAMED_COLORS.indexOf(trimmed) !== -1) {
    return { value: trimmed };
  }
  return { error: trimmed + " is not a colour this document accepts (oklch(...), #hex, or a basic name)." };
}

export function parseTokenValue(name: string, value: string): { value?: string; error?: string } {
  const spec = SPEC_BY_NAME[name];
  if (!spec) return { error: name + " is not adjustable on this document." };
  if (typeof value !== "string") return { error: "That value is not text." };
  return spec.kind === "length" ? parseLength(spec, value) : parseColor(spec, value);
}

/** The inline style attribute for the .rsm root. Invalid entries are omitted. */
export function styleAttributeFor(overrides: Record<string, string>): string {
  return Object.keys(overrides)
    .sort()
    .map((name) => {
      const parsed = parseTokenValue(name, overrides[name]);
      return parsed.value === undefined ? null : name + ":" + parsed.value;
    })
    .filter((d): d is string => d !== null)
    .join(";");
}

export const PAGE_MARGIN = { min: 0.25, max: 1.5, units: ["in", "mm", "px"] };
const PAGE_MARGIN_RE = /^[0-9]+(\.[0-9]+)?(in|mm|px)$/;

/**
 * The page margin is NOT a token. It is the `margin` attribute on <doc-page>
 * (ResumeDocument.tsx:76), which doc-page.js maps to its own --doc-page-margin
 * on an ANCESTOR of .rsm — unreachable from an inline override on .rsm under
 * any spelling. Its bounds are in whatever unit was given, so mm and px are
 * converted to inches before the range check.
 */
export function parsePageMargin(value: string): { value?: string; error?: string } {
  const trimmed = String(value).trim();
  if (!PAGE_MARGIN_RE.test(trimmed)) {
    return { error: trimmed + " is not a page margin (a number with in, mm or px)." };
  }
  const n = parseFloat(trimmed);
  const unit = trimmed.replace(/^[0-9.]+/, "");
  const inches = unit === "in" ? n : unit === "mm" ? n / 25.4 : n / 96;
  if (inches < PAGE_MARGIN.min || inches > PAGE_MARGIN.max) {
    return { error: "The page margin must be between " + PAGE_MARGIN.min + "in and " + PAGE_MARGIN.max + "in." };
  }
  return { value: trimmed };
}

/**
 * The same allowlist expressed as sanitize-html's `allowedStyles` shape, so the
 * sanitizer and the write path cannot drift. Values are matched by the same
 * regexes; range checks are the write path's job, and a saved out-of-range value
 * is a cosmetic problem, never a safety one.
 */
export const TOKEN_STYLE_RULES: Record<string, RegExp[]> = (() => {
  const rules: Record<string, RegExp[]> = {};
  DESIGN_TOKENS.forEach((t) => {
    rules[t.name] = t.kind === "length" ? [LENGTH_RE] : [OKLCH_RE, HEX_RE, new RegExp("^(" + NAMED_COLORS.join("|") + ")$")];
  });
  return rules;
})();
