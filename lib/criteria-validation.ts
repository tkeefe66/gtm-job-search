export type ValidationResult =
  | { ok: true; value: string[] }
  | { ok: false; error: string };

/**
 * Trim, collapse internal whitespace (\s covers U+00A0, which scraped and
 * pasted titles are full of), drop blanks, and de-duplicate case-insensitively
 * while keeping the first spelling the user typed.
 */
export function normalizeList(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const cleaned = raw.replace(/\s+/g, " ").trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}

export function validateList(items: string[], label: string): ValidationResult {
  const value = normalizeList(items);

  if (value.length === 0) {
    return {
      ok: false,
      // An empty list is the worst possible save: the crawler would extract
      // nothing from every tracked company and report "no roles" forever, with
      // no error anywhere. Blocked rather than warned.
      error: `${label} cannot be empty — an empty list makes every search and every crawl return nothing. Add at least one entry, or use Reset to defaults.`,
    };
  }

  const quoted = value.find((v) => v.includes('"'));
  if (quoted) {
    return {
      ok: false,
      // titleQueries builds `"${title}" ${place} job opening`; an embedded
      // quote produces a malformed search that fails silently.
      error: `Remove the " character from "${quoted}" — search queries wrap each entry in quotes, so an embedded quote produces a malformed search.`,
    };
  }

  return { ok: true, value };
}

/**
 * The fit brain's length guideline. Today's shipped default is ~1,800
 * characters; it is pasted verbatim into EVERY scoreFit call, so its length is
 * paid once per role scored — and a rescore pays it once per row all over
 * again. Advisory, not a limit.
 */
export const FIT_BRAIN_MAX_CHARS = 4000;

export interface TextCheck {
  /** Blocks the save. Mirrors saveCriteriaText's own empty check. */
  error: string | null;
  /** Shown, but the save is still allowed. */
  warning: string | null;
}

/**
 * Checks a free-text setting before it is saved.
 *
 * Two OUTCOMES, deliberately not one. Empty is an error because a blank fit
 * brain or location rule silently guts the prompt it is pasted into; over-long
 * is only a warning because there is no correct maximum — the cost is real but
 * the user may well want the longer text. Collapsing them into a single
 * `ok: boolean` would force one of those two behaviors onto the other.
 *
 * Length is measured on the TRIMMED text, because trimmed is what
 * saveCriteriaText stores and therefore what every prompt pays for.
 */
export function validateText(
  text: string,
  label: string,
  maxChars: number
): TextCheck {
  const trimmed = text.trim();

  if (!trimmed) {
    return { error: `${label} cannot be empty.`, warning: null };
  }

  if (trimmed.length > maxChars) {
    return {
      error: null,
      warning:
        `${label} is ${trimmed.length} characters, over the ${maxChars}-character ` +
        `guideline. It is sent on every fit-scoring call, so the extra length is ` +
        `paid once per role scored. You can still save it.`,
    };
  }

  return { error: null, warning: null };
}
