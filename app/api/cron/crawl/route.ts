import { NextResponse } from "next/server";
import { crawlCompany, loadRunContext, type CrawlOutcome } from "@/lib/crawler";
import { DEFAULT_BATCH_LIMIT } from "@/lib/crawl-schedule";
import { getDueCompanies } from "@/app/actions/watchlist";
import { repairJobLinks, type LinkRepairReport } from "@/app/actions/link-health";
import { runAsPlatform, runAsTenant } from "@/lib/platform-context";
import { splitCrawlBatch } from "@/lib/crawl-fairness";
import { withBudget } from "@/lib/metered";
import { listCrawlableTenants } from "@/app/actions/admin";
import { cronAuthorized } from "@/lib/cron-auth";

// Ceiling on caller-supplied `?limit=`. Without one, `?limit=100000` (or a
// typo in the cron command) selects every due company and crawls them all
// sequentially in one request — blowing past any HTTP timeout and burning an
// unbounded number of Claude calls. `DEFAULT_BATCH_LIMIT` is "the lever" for
// normal operation; this is the backstop for when that lever is turned too
// far.
const MAX_BATCH_LIMIT = 50;

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!cronAuthorized(req)) {
    return new NextResponse(null, { status: 401 });
  }

  // Everything past the secret check runs as the PLATFORM. This route has no
  // browser session, but its call chain reaches server actions three levels down
  // (crawlCompany → ingestRoles → addJob / updateJob / scoreFit) and those
  // require one. Without this wrapper every scheduled crawl throws on every role
  // it tries to save — and because outcomes are reported per company rather than
  // thrown, it would read as a clean run that found nothing.
  //
  // Deliberately INSIDE the authorization check: the platform identity is
  // granted by CRON_SECRET, never by reaching this file.
  return runAsPlatform(() => handleCrawl(req));
}

async function handleCrawl(req: Request) {
  const url = new URL(req.url);
  // Any presence of `dry` means dry-run unless explicitly disabled — a flag
  // whose whole purpose is safety must fail toward *not* writing when the
  // caller's spelling is unrecognized (`?dry=true`, `?dry=yes`, bare `?dry`),
  // not silently perform a real, credit-spending, database-writing run.
  const dryParam = url.searchParams.get("dry");
  const dryRun = dryParam !== null && dryParam !== "0" && dryParam !== "false";
  const rawLimit = Math.floor(Number(url.searchParams.get("limit")));
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, MAX_BATCH_LIMIT)
      : DEFAULT_BATCH_LIMIT;

  // Every ACTIVE tenant gets crawled, not just the admin. Before this loop the
  // platform resolved to one tenant, so a second tenant's tracked companies
  // would never have been crawled and any result would have landed in the
  // admin's pipeline — silently, since a watchlist that is never crawled looks
  // exactly like companies that are never hiring.
  const { tenants, error: tenantError } = await listCrawlableTenants();
  if (tenantError !== undefined) {
    console.error(`cron/crawl: could not list tenants — ${tenantError}`);
    return NextResponse.json({ error: tenantError }, { status: 500 });
  }

  // The budget is 3 sequential crawls at 60-120s each, so with more tenants than
  // slots somebody misses out every night. The rotation decides that it is a
  // DIFFERENT somebody each night — see lib/crawl-fairness.ts. Day number, so a
  // run repeated within a day does not reshuffle.
  const rotation = Math.floor(Date.now() / 86_400_000);
  const slices = splitCrawlBatch(tenants.map((t) => t.id), limit, rotation);

  const results: CrawlOutcome[] = [];
  // An accumulator object rather than a `let`: TypeScript cannot follow an
  // assignment made inside an async callback and narrows the variable to `never`,
  // so the reads below stop type-checking.
  const linkAcc: { value: LinkRepairReport | null } = { value: null };

  for (const slice of slices) {
    // One scope per tenant. loadRunContext resolves ONE criteria set per batch
    // precisely because mixing two title lists produces a run whose results
    // cannot be interpreted — which is the same reason the scope is per tenant
    // rather than per run.
    const isAdmin = tenants.find((t) => t.id === slice.tenantId)?.isAdmin ?? false;

    await runAsTenant(slice.tenantId, async () => {
      // METERED, like every interactive path. This is the only work that spends
      // while nobody is watching, so leaving it uncapped would mean the ceiling
      // bounded the clicks and not the thing most able to run away.
      //
      // A capped tenant is SKIPPED, not failed: their budget is exhausted, which
      // is a normal state, and a nightly job that reports failure for it would
      // cry wolf every night until the period rolled over.
      const budget = await withBudget({
        action: "crawl",
        estimateCents: 10 * slice.limit,
        isAdmin,
        fn: async () => {
      const { companies: due, error } = await getDueCompanies(slice.limit);
      if (error) {
        console.error(`cron/crawl: due companies failed for a tenant — ${error}`);
        return;
      }
      if (due.length > 0) {
        const ctx = await loadRunContext();
        for (const company of due) {
          try {
            results.push(await crawlCompany(company, { dryRun, ctx }));
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`cron/crawl: ${company} threw — ${message}`);
            results.push({
              company,
              method: null,
              rolesFound: 0,
              newRoles: 0,
              status: "error",
              error: message,
            });
          }
        }
      }

      // Link rot is per tenant too: repairJobLinks reads that tenant's jobs.
      // Running it once outside the loop would have repaired only one tenant's
      // links, under RLS, and reported the count as if it covered everyone.
      if (!dryRun) {
        try {
          const report = await repairJobLinks();
          const prev = linkAcc.value;
          // Summed across tenants, not replaced. Reporting only the last
          // tenant's numbers would understate the run and look like link repair
          // had barely done anything.
          linkAcc.value = prev
            ? {
                ...report,
                checked: prev.checked + report.checked,
                relinked: prev.relinked + report.relinked,
                closed: prev.closed + report.closed,
                closedUnlisted: prev.closedUnlisted + report.closedUnlisted,
                unclear: [...prev.unclear, ...report.unclear],
              }
            : report;
        } catch (err) {
          console.error(
            `cron/crawl: link repair threw — ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
        },
      });

      if (budget.capped) {
        // Expected, not exceptional. Logged so a quiet night is explainable
        // rather than looking like a crawler that stopped working.
        console.log(`cron/crawl: skipped a tenant — ${budget.capped}`);
      } else if (budget.error !== undefined) {
        console.error(`cron/crawl: budget check failed — ${budget.error}`);
      }
    });
  }

  const totals = {
    newRoles: results.reduce((n, r) => n + r.newRoles, 0),
    // needs_url counts as failed too — a batch where every company failed to
    // resolve a careers page is a real problem, not a silent 0.
    failed: results.filter((r) => r.status === "error" || r.status === "needs_url")
      .length,
  };

  // The response body lands in the `crawler` service's curl output, not the
  // `web` service's logs — and vanishes entirely if that output is
  // redirected. This is the only durable record of a successful run in the
  // logs a human actually checks.
  console.log(
    `cron/crawl: dryRun=${dryRun} crawled=${results.length} newRoles=${totals.newRoles} failed=${totals.failed}` +
      (linkAcc.value
        ? ` links=${linkAcc.value.checked} relinked=${linkAcc.value.relinked} ` +
          `closed=${linkAcc.value.closed + linkAcc.value.closedUnlisted} unclear=${linkAcc.value.unclear.length}`
        : "")
  );

  return NextResponse.json({
    dryRun,
    crawled: results.length,
    totals,
    results,
    links: linkAcc.value,
  });
}
