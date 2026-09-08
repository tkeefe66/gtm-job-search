// Remembering where a company's hiring board is — including that it has none.
//
// Resolution costs no Claude tokens but real TIME: a company that resolves to
// nothing is up to slugs × vendors sequential fetches at an 8s timeout, on top
// of a measured 91.2s worst-case crawl, inside a request Railway closes after
// 300s of silence. The remembered FAILURE matters as much as the remembered
// board — without it, every crawl re-pays the whole sweep for a company that
// has no board at all.
//
// The decision is pure and lives here; the SQL is in lib/crawler.ts alongside
// its other queries.

import type { BoardVendor } from "@/lib/ats-boards";

/** One row of `company_boards`, as the crawl reads it. */
export interface StoredBoard {
  vendor: string | null;
  slug: string | null;
  /** 'read' or 'guessed' — see lib/board-source.ts. Null on a remembered failure. */
  source: string | null;
  checkedAt: string;
}

/**
 * How long a remembered answer stands.
 *
 * Companies move ATS, and a board that stops resolving is a signal in its own
 * right (see the crawl's log line), so nothing is remembered forever. Long
 * enough that a nightly crawl does not re-probe, short enough that a migration
 * between vendors is noticed within a month.
 */
export const BOARD_RECHECK_DAYS = 30;

export type BoardRecall =
  /** Use this board; it is fresh and its provenance is known. */
  | { kind: "use"; board: StoredBoard & { vendor: BoardVendor; slug: string } }
  /** This company was checked recently and has no usable board. Skip the sweep. */
  | { kind: "skip" }
  /** Nothing usable remembered — resolve it now. */
  | { kind: "resolve" };

/**
 * What to do with what we remember about a company's board.
 *
 * Every uncertain case resolves rather than skips: re-resolving costs seconds,
 * while skipping on a bad value costs a company that silently never uses its
 * board again. That includes a row with no recorded `source`, because the
 * read-versus-guessed distinction is the whole safety story and a row that
 * cannot state it may not be acted on.
 */
export function boardRecall(stored: StoredBoard | null): BoardRecall {
  if (!stored) return { kind: "resolve" };

  const checked = Date.parse(stored.checkedAt);
  if (!Number.isFinite(checked)) return { kind: "resolve" };
  const ageDays = (Date.now() - checked) / (24 * 60 * 60 * 1000);
  if (ageDays > BOARD_RECHECK_DAYS) return { kind: "resolve" };

  if (stored.vendor === null || stored.slug === null) return { kind: "skip" };
  if (stored.source !== "read" && stored.source !== "guessed") return { kind: "resolve" };

  return {
    kind: "use",
    board: { ...stored, vendor: stored.vendor as BoardVendor, slug: stored.slug },
  };
}
