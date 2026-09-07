// app/api/cron/purge-resumes/route.ts
import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cron-auth";
import { runAsPlatform } from "@/lib/platform-context";
import { listAllTenantIds } from "@/app/actions/admin";
import { runPurge, liveDeps } from "@/lib/saved-resume-purge";

export const dynamic = "force-dynamic";

/**
 * Deletes saved résumés past their 60-day window, for every tenant.
 *
 * This is the PRIMARY retention mechanism. Two others back it: listSavedResumes
 * purges the calling tenant opportunistically (so an active user's retention
 * survives this route being down — CLAUDE.md records the crawl route 404-ing
 * nightly for days with nothing surfacing it), and both reads filter
 * LIVE_PREDICATE so an unpurged expired row is never shown.
 *
 * `oldestSurviving` is reported so a STALLED purge is detectable from the
 * route's own output rather than from someone noticing an old row.
 */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) {
    return new NextResponse(null, { status: 401 });
  }
  // Deliberately INSIDE the authorization check: the platform identity is
  // granted by CRON_SECRET, never by reaching this file.
  return runAsPlatform(async () => {
    const url = new URL(req.url);
    // Same doctrine as both crawl routes: any presence of `dry` means dry-run
    // unless explicitly disabled, so an unrecognised spelling fails toward not
    // writing.
    const dryParam = url.searchParams.get("dry");
    const dryRun = dryParam !== null && dryParam !== "0" && dryParam !== "false";

    const report = await runPurge(liveDeps(listAllTenantIds, dryRun));

    console.log(
      `cron/purge-resumes: dryRun=${dryRun} deleted=${report.deleted} ` +
        `tenants=${report.tenants} failed=${report.failed} ` +
        `oldestSurviving=${report.oldestSurviving ?? "none"}`
    );

    if (report.error !== undefined) {
      return NextResponse.json({ ...report }, { status: 500 });
    }
    // A run that reports {deleted: n} while half the tenants errored is the
    // silent-success shape .claude/skills/swallowed-string-errors exists for.
    return NextResponse.json({ ...report }, { status: report.failed > 0 ? 500 : 200 });
  });
}
