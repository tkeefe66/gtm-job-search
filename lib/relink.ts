/**
 * The patch that repairs a job's link.
 *
 * One definition, because there are now three call sites: both branches of
 * repairOne (app/actions/link-health.ts) and the backfill's `relink` gate
 * (app/actions/enrich.ts). The rule it encodes is not obvious enough to retype:
 * `source_url` keeps the link being REPLACED, so a relink is never lossy — the
 * slug behind it may have been a guess, and a wrong one would otherwise destroy
 * the only URL the role ever had — and it is written on the FIRST relink only,
 * so a re-run cannot overwrite the original with a previous resolution.
 */
export function relinkPatch(
  job: { source_url: string | null },
  replacedUrl: string,
  newUrl: string
): { job_url: string; source_url: string } {
  return { job_url: newUrl, source_url: job.source_url ?? replacedUrl };
}
