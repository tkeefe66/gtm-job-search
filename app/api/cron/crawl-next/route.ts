import { NextResponse } from "next/server";
import { crawlCompany, loadRunContext } from "@/lib/crawler";
import { cronAuthorized } from "@/lib/cron-auth";
import { getCrawlCandidate } from "@/app/actions/watchlist";
import { listCrawlableTenants } from "@/app/actions/admin";
import { pickNextTenant, type TenantCandidate } from "@/lib/crawl-next";
import { runAsPlatform, runAsTenant } from "@/lib/platform-context";
import { withBudget } from "@/lib/metered";

export const dynamic = "force-dynamic";

/**
 * ONE company per request.
 *
 * WHY, in one number: Railway's edge closes a request that transfers no data
 * after 300 seconds. The older /api/cron/crawl route works a whole batch and
 * then returns JSON, so it is a silent request and gets those 300 seconds —
 * against a measured worst-case crawl of 91.2s, that is 3.29 companies, which is
 * why DEFAULT_BATCH_LIMIT is 3 and why raising it does not work. (`--max-time
 * 400` in the crawler service's command is dead configuration: the edge cuts
 * first.) Design and measurements:
 * docs/superpowers/specs/2026-08-17-crawl-throughput-design.md.
 *
 * Shrinking the request to one company makes the unit of work and the unit of
 * failure the same thing. Each call is ~91s against a 300s limit — 3x margin,
 * no streaming needed — and capacity stops being bounded by the edge at all. It
 * becomes bounded by how many times the caller loops, which is a number in a
 * shell command rather than a constant behind a deploy.
 *
 * The caller is expected to loop until `crawled` is false. That terminates,
 * because crawlCompany advances last_checked_at on EVERY outcome including
 * failure (lib/crawler.ts), so a company cannot be picked twice in a window and
 * a broken one leaves the due set rather than spinning.
 */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) {
    return new NextResponse(null, { status: 401 });
  }
  return runAsPlatform(() => handleCrawlNext(req));
}

async function handleCrawlNext(req: Request) {
  const url = new URL(req.url);
  // Same doctrine as the batch route: any presence of `dry` means dry-run unless
  // explicitly disabled, so an unrecognized spelling fails toward not writing.
  const dryParam = url.searchParams.get("dry");
  const dryRun = dryParam !== null && dryParam !== "0" && dryParam !== "false";

  const { tenants, error: tenantError } = await listCrawlableTenants();
  if (tenantError !== undefined) {
    console.error(`cron/crawl-next: could not list tenants — ${tenantError}`);
    return NextResponse.json({ error: tenantError }, { status: 500 });
  }

  // Ask each tenant separately, INSIDE that tenant's own scope. There is no
  // cross-tenant query here and there must not be: `tenant_isolation` compares
  // tenant_id to a per-connection GUC, and app_rw is neither superuser nor
  // BYPASSRLS, so a query with no tenant set returns zero rows silently.
  // lib/crawl-next.ts carries the full reasoning.
  const candidates: TenantCandidate[] = [];
  for (const tenant of tenants) {
    const c = await runAsTenant(tenant.id, () => getCrawlCandidate());
    if (c.error !== undefined) {
      // One tenant's read failing must not stop the others being crawled.
      console.error(`cron/crawl-next: candidate read failed for a tenant — ${c.error}`);
      continue;
    }
    candidates.push({
      tenantId: tenant.id,
      company: c.company,
      crawlsToday: c.crawlsToday,
      lastCheckedAt: c.lastCheckedAt,
    });
  }

  const pick = pickNextTenant(candidates);
  if (!pick || pick.company === null) {
    console.log(`cron/crawl-next: nothing due across ${candidates.length} tenant(s)`);
    return NextResponse.json({ crawled: false, tenantsWithWork: 0 });
  }

  const tenantsWithWork = candidates.filter((c) => c.company !== null).length;
  const isAdmin = tenants.find((t) => t.id === pick.tenantId)?.isAdmin ?? false;
  const company = pick.company;

  return runAsTenant(pick.tenantId, async () => {
    // Metered exactly like the batch route. This is work that spends while
    // nobody is watching, and the loop makes it spend more often, so the
    // ceiling matters more here than anywhere a human is clicking.
    //
    // A capped tenant is SKIPPED, not failed — an exhausted budget is a normal
    // state. It reports crawled:false so the caller's loop ends rather than
    // spinning on a tenant that can never proceed; the next window picks it up.
    const budget = await withBudget({
      action: "crawl",
      estimateCents: 10,
      isAdmin,
      fn: async () => {
        const ctx = await loadRunContext();
        return crawlCompany(company, { dryRun, ctx });
      },
    });

    if (budget.capped) {
      console.log(`cron/crawl-next: skipped a tenant — ${budget.capped}`);
      return NextResponse.json({ crawled: false, capped: true, tenantsWithWork });
    }
    if (budget.error !== undefined) {
      console.error(`cron/crawl-next: budget check failed — ${budget.error}`);
      return NextResponse.json({ crawled: false, error: budget.error }, { status: 500 });
    }

    const result = budget.result ?? null;
    console.log(
      `cron/crawl-next: dryRun=${dryRun} company=${company} status=${result?.status ?? "unknown"} ` +
        `newRoles=${result?.newRoles ?? 0} tenantsWithWork=${tenantsWithWork}`
    );

    return NextResponse.json({ crawled: true, company, result, tenantsWithWork });
  });
}
