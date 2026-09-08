// lib/saved-resume-shape.ts
// Row -> summary, in lib/ rather than app/actions/ for two reasons. First, the
// one the brief gave: app/actions/saved-resumes.ts is "use server", which
// forbids non-async exports, so the mapper cannot live there — same split,
// same reason, as lib/fit-prompt.ts against app/actions/parse-role.ts, and
// that precedent is itself in lib/, not app/actions/. Second, a discovered
// one: app/actions/auth-required.test.ts globs every non-test .ts file
// directly under app/actions/ and calls each of its exported functions
// expecting a rejected Promise; a sync mapper placed there is picked up as an
// unguarded "action" and fails that test with a TypeError instead of the
// expected /Not authenticated/ rejection. Living in lib/ sidesteps the scan
// entirely rather than special-casing the guard test for a non-action file.
import type { SavedResumeSummary } from "@/lib/types";

export interface SavedSummaryRow {
  id: string;
  job_id: string | null;
  role_title: string;
  company: string;
  label: string | null;
  created_at: string;
  expires_at: string;
  page_margin: string | null;
  kind: string;
  has_content: boolean;
}

export function savedRowToSummary(r: SavedSummaryRow): SavedResumeSummary {
  return {
    id: r.id,
    jobId: r.job_id,
    roleTitle: r.role_title,
    company: r.company,
    label: r.label,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    pageMargin: r.page_margin,
    kind: r.kind === "checkpoint" ? "checkpoint" : "save",
    hasContent: r.has_content === true,
  };
}
