// Discover's read-time dedupe, lifted out of app/actions/discover.ts.
//
// It lives here for the reason every other pure fragment in this directory
// does: `"use server"` forbids non-async exports, so as a loop inside
// getAllDiscoveredStartups this logic was reachable from no test in the repo
// — and it is exactly the kind of logic (a keying rule, a first-wins rule, a
// list-append rule) where a silent change shows up as missing cards rather
// than as an error.

import { companyIdentityKey } from "@/lib/role-key";
import { legacySignalFrom } from "@/lib/legacy-signal";
import type { Startup } from "@/lib/types";

export type DateRange = "7d" | "30d" | "3m" | "6m" | "6-18m" | "current";

// A startup annotated with the date-range window of the discovered_startups
// row it was read from. mergeDiscoveredStartups dedupes by company across
// every cached window, so this is how a caller (Discover.tsx) tells a company
// found last week apart from one found 6-18 months ago.
export type DiscoveredStartup = Startup & {
  discovered_range: DateRange;
  /**
   * Every distinct signal this employer triggered, across every cached row —
   * including duplicate returns within one search (Probe A returned Lockheed
   * Martin twice, and the old dedupe kept only the first, silently dropping
   * the second real contract), legitimate repeats across different windows,
   * and — since companyIdentityKey replaced normalizeCompanyName here —
   * signals filed under different SPELLINGS of the same employer's name.
   * `signal` still holds just the most recent one; this is the full list a
   * card renders. A row whose signal composed to "" contributes no entry.
   */
  signals: string[];
  /**
   * Every distinct spelling of this employer's name that merged into this
   * card, most-recent first — `[]` when only one spelling was ever seen.
   *
   * Rendered as a subtitle rather than dropped, because the merge is a GUESS:
   * companyIdentityKey merges on a sorted token set, so an employer that
   * genuinely trades under two word-order variants and one that was merged in
   * error look identical from here. Showing the alternates is what lets a
   * reader notice the second case. See the note on companyIdentityKey in
   * lib/role-key.ts for what the rule accepts.
   */
  alsoKnownAs: string[];
};

export interface DiscoveredRow {
  startups: Startup[];
  date_range: string;
}

/**
 * Collapses every cached discovered_startups row into one card per employer.
 *
 * `rows` MUST arrive ordered fetched_at DESCENDING: the first occurrence of a
 * key sets the card's core fields (company/tagline/careers_url/headquarters/
 * location) from the most-recently-fetched row, and every later occurrence
 * only contributes a signal line and, if it spells the name differently, an
 * `alsoKnownAs` entry.
 */
export function mergeDiscoveredStartups(rows: DiscoveredRow[]): DiscoveredStartup[] {
  const byKey = new Map<string, DiscoveredStartup>();

  for (const row of rows) {
    for (const s of row.startups) {
      const key = companyIdentityKey(s.company);
      const signalLine = s.signal ?? legacySignalFrom(s);
      const existing = byKey.get(key);

      if (!existing) {
        byKey.set(key, {
          ...s,
          discovered_range: row.date_range as DateRange,
          signals: signalLine ? [signalLine] : [],
          alsoKnownAs: [],
        });
        continue;
      }

      if (signalLine && !existing.signals.includes(signalLine)) {
        existing.signals.push(signalLine);
      }
      // Compared against the card's own company AND the alternates already
      // collected, so a spelling seen three times is listed once.
      if (s.company !== existing.company && !existing.alsoKnownAs.includes(s.company)) {
        existing.alsoKnownAs.push(s.company);
      }
    }
  }

  return Array.from(byKey.values());
}
