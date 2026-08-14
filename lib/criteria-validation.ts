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
