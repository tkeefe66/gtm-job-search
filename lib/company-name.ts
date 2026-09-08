// Correcting a company name against the employer's own spelling.
//
// The extraction transcribes a company name out of a search result, and it
// slips: measured 2026-09-07 against 120 rows' schema.org hiringOrganization,
// three rows read "basten" for Baseten. That is not cosmetic —
// normalizeCompanyName treats it as a different employer, so it produces a
// second Discover card, a board-slug guess that cannot resolve, and a watchlist
// entry that never matches the rows it should.
//
// Deliberately narrow: it fixes SPELLING, never naming. An employer's board
// often files a posting under a legal entity ("4050 Entegris Malaysia SDN Bhd")
// or a shorter brand ("Fireworks" for "Fireworks AI"), and neither is an
// improvement on the name the user recognises.

/** Case, punctuation and spacing removed — what a "same spelling" test compares. */
function collapse(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Levenshtein, iterative and bounded by the strings themselves. */
function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const carry = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      diagonal = carry;
    }
  }
  return prev[b.length];
}

/**
 * The employer's spelling, when it is the same name spelled better — otherwise
 * null, meaning keep what is stored.
 *
 * Two rules, both drawn from the measured cases:
 *
 * A difference of whole WORDS is a different name, not a misspelling. "Acme"
 * and "Acme Health" may well be different employers, and "Fireworks AI" versus
 * the board's "Fireworks" is a real disagreement where the stored name is at
 * least as good. Only same-word-count names are compared.
 *
 * The edit budget scales with length: one slip in a short name can be a
 * different company ("Clay" / "Cloud"), while two in a long one is still
 * obviously the same word ("Smartsheeet" / "Smartsheet").
 */
export function betterCompanyName(
  stored: string,
  employerDeclared: string | null | undefined
): string | null {
  const declared = (employerDeclared ?? "").trim();
  if (declared === "" || stored.trim() === "") return null;
  if (declared === stored.trim()) return null;

  const a = collapse(stored);
  const b = collapse(declared);
  if (a === "" || b === "") return null;
  // Same letters: only casing or punctuation differ, so this is the same name
  // better written — checked BEFORE the word rule, since "Level-Access" and
  // "Level Access" disagree on word count while being the same string.
  if (a === b) return declared;

  const words = (s: string) => s.trim().split(/\s+/).length;
  if (words(declared) !== words(stored)) return null;

  const budget = Math.min(2, Math.floor(Math.max(a.length, b.length) / 5));
  return editDistance(a, b) <= budget ? declared : null;
}
