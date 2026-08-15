import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { crawlCompany, loadRunContext, type CrawlOutcome } from "@/lib/crawler";
import { DEFAULT_BATCH_LIMIT } from "@/lib/crawl-schedule";
import { getDueCompanies } from "@/app/actions/watchlist";
import { repairJobLinks, type LinkRepairReport } from "@/app/actions/link-health";

// Ceiling on caller-supplied `?limit=`. Without one, `?limit=100000` (or a
// typo in the cron command) selects every due company and crawls them all
// sequentially in one request — blowing past any HTTP timeout and burning an
// unbounded number of Claude calls. `DEFAULT_BATCH_LIMIT` is "the lever" for
// normal operation; this is the backstop for when that lever is turned too
// far.
const MAX_BATCH_LIMIT = 50;

export const dynamic = "force-dynamic";

// This is the only API route in the app. It both mutates the database and
// spends Anthropic credits, and the app has no auth, so the shared secret is
// the only thing standing between a public URL and unbounded spend.
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const provided =
    header.slice(0, 7).toLowerCase() === "bearer " ? header.slice(7) : "";
  // Hash both sides to fixed-width digests before comparing: this removes
  // the length as an observable side channel (timingSafeEqual would
  // otherwise require an explicit length-equality check, and a length
  // mismatch on the raw values would throw) and keeps the comparison itself
  // genuinely constant-time regardless of what the caller sent.
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return new NextResponse(null, { status: 401 });
  }

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

  // Routed through the same server action the rest of the app uses, rather
  // than duplicating the query inline, so there is exactly one code path
  // that decides "which companies are due" (getDueCompanies in
  // app/actions/watchlist.ts, backed by DUE_COMPANIES_SQL).
  const { companies: due, error } = await getDueCompanies(limit);
  if (error) {
    console.error(`cron/crawl: could not select due companies — ${error}`);
    return NextResponse.json(
      { error: `Could not select due companies: ${error}` },
      { status: 500 }
    );
  }

  const results: CrawlOutcome[] = [];

  // Skipped entirely when nothing is due — which is most ticks. The context is
  // a settings read plus the run-history lookups behind it, and spending them
  // to crawl zero companies is pure waste.
  if (due.length > 0) {
    // Resolved ONCE for the whole batch, before the loop. Two reasons, and the
    // first is the load-bearing one: a settings save landing halfway through a
    // batch would otherwise crawl the first companies against the old title
    // list and the rest against the new one, producing a run whose results
    // cannot be interpreted. Second, it is one settings read per batch instead
    // of one per company.
    const ctx = await loadRunContext();

    // Sequential on purpose: avoids bursting the Anthropic API by firing many
    // concurrent web_search-tier calls at once. This does NOT keep the request
    // inside normal HTTP timeouts — a search-tier crawl is ~60-120s, so a full
    // batch can run well past what most timeouts allow (see DEFAULT_BATCH_LIMIT's
    // comment in lib/crawl-schedule.ts). The batch self-heals against that:
    // each company's last_checked_at advances as it completes, so a request
    // that gets cut off mid-batch simply resumes with the next-due companies
    // on the following run. One company failing never aborts the batch either.
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

  // Link rot is a daily problem, not a per-crawl one: a posting closes without
  // anything about its company being due, so this runs on every tick rather
  // than only when `due` was non-empty. It spends no Claude credits — HTTP
  // plus the vendors' public board endpoints — which is why it can sit in a
  // route whose whole design is about rationing paid calls. A dry run skips it
  // because it writes.
  let links: LinkRepairReport | null = null;
  if (!dryRun) {
    try {
      links = await repairJobLinks();
    } catch (err) {
      // Never aborts the batch: the crawl above is the expensive part and its
      // results must still be reported.
      console.error(
        `cron/crawl: link repair threw — ${err instanceof Error ? err.message : String(err)}`
      );
    }
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
      (links
        ? ` links=${links.checked} relinked=${links.relinked} ` +
          `closed=${links.closed + links.closedUnlisted} unclear=${links.unclear.length}`
        : "")
  );

  return NextResponse.json({
    dryRun,
    crawled: results.length,
    totals,
    results,
    links,
  });
}
