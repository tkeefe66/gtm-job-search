// lib/saved-resume-grouping.ts
//
// The archive screen's grouping, in lib/ rather than in the component, for the
// reason CLAUDE.md gives repeatedly about this repo: vitest's include list is
// lib/** and app/** only, so a function living in components/ is reachable from
// no test in the suite and a wrong key would ship green.
import type { SavedResumeSummary } from "@/lib/types";

export interface SavedResumeGroup {
  key: string;
  roleTitle: string;
  company: string;
  jobId: string | null;
  items: SavedResumeSummary[];
}

/**
 * Groups by job, falling back to role+company for rows whose job was deleted
 * (job_id goes null, by migration 016's ON DELETE SET NULL).
 *
 * A deleted-job row deliberately does NOT merge into a live job's group even
 * when the role and company match: the heading links to the working draft, and
 * a card that no longer belongs to that job would be filed under a link it did
 * not come from.
 *
 * Insertion order is preserved and listSavedResumes returns newest-first, so
 * groups come out ordered by their newest save and each group's items stay
 * newest-first without a second sort.
 */
export function groupResumes(resumes: SavedResumeSummary[]): SavedResumeGroup[] {
  const groups: SavedResumeGroup[] = [];
  const byKey: Record<string, SavedResumeGroup> = {};
  for (let i = 0; i < resumes.length; i++) {
    const r = resumes[i];
    const key = r.jobId !== null ? "job:" + r.jobId : "name:" + r.roleTitle + "|" + r.company;
    let g = byKey[key];
    if (!g) {
      g = { key, roleTitle: r.roleTitle, company: r.company, jobId: r.jobId, items: [] };
      byKey[key] = g;
      groups.push(g);
    }
    g.items.push(r);
  }
  return groups;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whole days from `now` until `expiresAt`, floored at 0.
 *
 * Rounded UP: a row with 30 hours left reads "2 days", never "1". The archive
 * emphasises this under 7 days, and rounding down would tell someone a résumé
 * expires sooner than it does.
 */
export function daysUntil(expiresAt: string, now: number): number {
  const ms = new Date(expiresAt).getTime() - now;
  return ms <= 0 ? 0 : Math.ceil(ms / DAY_MS);
}
