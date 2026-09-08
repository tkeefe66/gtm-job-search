// What the rendered document actually measures, so the chat can see the page
// rather than only the selection that produced it.
//
// The house-style rules (lib/house-style.ts) judge the document MODEL — the
// taper, the roles, the positioning. They are blind by construction to anything
// that only exists once type is set: how many pages it runs to, whether the
// last one carries two lines and a lot of white. Clearing the tagline is the
// case that proved it — the rules correctly said nothing, and the header
// rendered with a hole in it.
//
// The measurement is taken in the BROWSER (public/resume-design/rsm-page-guides.js
// already walks the fragments and knows the page height) and travels with the
// chat turn. That makes it caller-supplied data on its way into a model prompt,
// so `parseGeometry` is a gate, not a formality: it accepts finite numbers in a
// sane range and nothing else.

export interface PageGeometry {
  /** How many pages the document occupies. */
  pages: number;
  /** How much of the LAST page carries content, 0–1. */
  lastPageFill: number;
}

/** Below this share of the final page, the page reads as a stray rather than a
 *  page. Strictly below — a document sitting exactly on the line has met it. */
export const LAST_PAGE_THIN = 0.15;

const MAX_PAGES = 20;

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/** Validate a measurement from the client. Returns null rather than a repaired
 *  object for anything malformed: a wrong number here becomes a sentence the
 *  model acts on, and silence is better than a confident wrong figure. */
export function parseGeometry(raw: unknown): PageGeometry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const g = raw as { pages?: unknown; lastPageFill?: unknown };
  if (!finite(g.pages) || !finite(g.lastPageFill)) return null;
  if (g.pages < 1 || g.pages > MAX_PAGES) return null;
  const pages = Math.round(g.pages);
  const lastPageFill = Math.min(1, Math.max(0, g.lastPageFill));
  return { pages, lastPageFill };
}

const WORD = ["", "one", "two", "three", "four", "five"];

function pageWord(n: number): string {
  return WORD[n] || String(n);
}

/**
 * Advisory notes about the rendered page. Never errors — the user asked for
 * whatever produced this, and a résumé that runs long on purpose is a choice.
 */
export function geometryNotes(g: PageGeometry): string[] {
  const notes: string[] = [];

  // A single page cannot have a stray final page, however little is on it —
  // that is just a short résumé, and flagging it would be noise on every
  // early draft.
  if (g.pages > 1 && g.lastPageFill < LAST_PAGE_THIN) {
    notes.push(
      `Page ${g.pages} carries only about ${Math.round(g.lastPageFill * 100)}% of a page of content, so the document ends with a nearly empty sheet. Tightening the taper or raising compress-after by one usually absorbs it.`
    );
  }
  if (g.pages > 2) {
    notes.push(
      `The résumé runs to ${pageWord(g.pages)} pages. Two is the normal ceiling for this record; past that the reader stops.`
    );
  }
  return notes;
}

/** The measurement as the model receives it. */
export function geometryBlock(g: PageGeometry | null): string {
  if (g === null) {
    return "The rendered page has not been measured for this turn, so say nothing about page count or white space.";
  }
  const notes = geometryNotes(g);
  const head = `The document renders to ${g.pages} page${g.pages === 1 ? "" : "s"}, with the last page about ${Math.round(g.lastPageFill * 100)}% full.`;
  if (notes.length === 0) return head + " Nothing about the layout needs attention.";
  return head + "\n" + notes.map((n) => `- ${n}`).join("\n");
}
